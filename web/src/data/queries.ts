import {
  ConnectionConfig,
  ConnectionConfigOptionalDatabase,
  Exec,
  ExecNoDb,
  Query,
  QueryNoDb,
  QueryOne,
  QueryTuples,
  SQLError
} from "@/data/client";
import {
  CityConfig,
  createCity,
  createOffers,
  DEFAULT_CITY,
  randomOffers
} from "@/data/offers";
import {
  BASE_DATA,
  FUNCTIONS,
  PROCEDURES,
  S3_BUCKET_NAME,
  TABLES
} from "@/data/sql";
import { boundsToWKTPolygon } from "@/geo";
import { ScaleFactor } from "@/scalefactors";
import { Bounds } from "pigeon-maps";

export const isConnected = async (config: ConnectionConfigOptionalDatabase) => {
  try {
    await ExecNoDb(config, "SELECT 1");
    return true;
  } catch (e) {
    return false;
  }
};

export const hasSchema = async (config: ConnectionConfig) => {
  const objects = await schemaObjects(config);
  return Object.values(objects).every((x) => x);
};

type schemaObjInfo = {
  tables: string[];
  procedures: string[];
  functions: string[];
};

export const schemaObjects = async (
  config: ConnectionConfig
): Promise<{ [key: string]: boolean }> => {
  let objs: schemaObjInfo = { tables: [], procedures: [], functions: [] };
  const { database, ...configNoDb } = config;

  try {
    objs = (
      await QueryTuples<[keyof schemaObjInfo, string]>(
        configNoDb,
        `
          SELECT "tables", table_name
          FROM information_schema.tables
          WHERE table_schema = ?
          UNION ALL
          SELECT (
            CASE routine_type
              WHEN 'PROCEDURE' THEN 'procedures'
              WHEN 'FUNCTION' THEN 'functions'
            END
          ), routine_name
          FROM information_schema.routines
          WHERE routine_schema = ?
        `,
        database,
        database
      )
    ).reduce((acc, [type, name]) => {
      acc[type].push(name);
      return acc;
    }, objs);
  } catch (e) {
    if (
      !(
        e instanceof SQLError &&
        (e.isUnknownDatabase() || e.isDatabaseRecovering())
      )
    ) {
      throw e;
    }
  }

  const { tables, procedures, functions } = objs;

  return Object.fromEntries(
    [
      TABLES.map(({ name }) => [name, tables.includes(name)]),
      PROCEDURES.map(({ name }) => [name, procedures.includes(name)]),
      FUNCTIONS.map(({ name }) => [name, functions.includes(name)]),
    ].flat()
  );
};

export const countPartitions = async (
  config: ConnectionConfig
): Promise<number> =>
  QueryOne<{ count: number }>(
    config,
    `
      SELECT COUNT(*) AS count
      FROM information_schema.distributed_partitions
      WHERE
        database_name = ?
        AND role = "Master"
    `,
    config.database
  ).then((x) => x.count);

export const dropDatabase = (config: ConnectionConfig) =>
  ExecNoDb(config, "DROP DATABASE IF EXISTS `" + config.database + "`");

export const resetSchema = async (
  config: ConnectionConfig,
  {
    progress,
    scaleFactor,
    includeSeedData,
    skipCreate = false,
  }: {
    progress: (msg: string, status: "info" | "success") => void;
    scaleFactor: ScaleFactor;
    includeSeedData: boolean;
    skipCreate: boolean;
  }
) => {
  if (!skipCreate) {
    progress("Dropping existing schema", "info");
    await dropDatabase(config);

    progress("Creating database", "info");
    await ExecNoDb(config, "CREATE DATABASE `" + config.database + "`");
  }

  for (const obj of FUNCTIONS) {
    progress(`Creating function: ${obj.name}`, "info");
    await Exec(config, obj.createStmt);
  }
  for (const obj of TABLES) {
    progress(`Creating table: ${obj.name}`, "info");
    await Exec(config, obj.createStmt);
  }
  for (const obj of PROCEDURES) {
    progress(`Creating procedure: ${obj.name}`, "info");
    await Exec(config, obj.createStmt);
  }

  await insertBaseData(config);
  await createCity(config, DEFAULT_CITY);

  if (includeSeedData) {
    progress("Creating sample data", "info");
    await insertSeedData(config, DEFAULT_CITY, scaleFactor);
  }

  progress("Schema initialized", "success");
};

export const insertBaseData = async (config: ConnectionConfig) => {
  for (const query of BASE_DATA) {
    await Exec(config, query);
  }
};

export const insertSeedData = (
  config: ConnectionConfig,
  city: CityConfig,
  scaleFactor: ScaleFactor
) => {
  const numOffers = 100 * scaleFactor.partitions;
  const offers = randomOffers(city, numOffers);
  return createOffers(config, offers);
};

export type SegmentConfig = {
  kind: "olc_8" | "purchase" | "request";
  interval: "minute" | "hour" | "day" | "week" | "month";
  value: string;
};

export const pipelineStatus = async (
  config: ConnectionConfig,
  scaleFactor: ScaleFactor
) => {
  const scaleFactorPrefix = scaleFactor.prefix;

  type Row = {
    cityId: number;
    cityName: string;
    lon: number;
    lat: number;
    diameter: number;
    pipelineName: string;
    needsUpdate: boolean;
  };

  return await Query<Row>(
    config,
    `
      SELECT
        expected.city_id AS cityId,
        expected.city_name AS cityName,
        GEOGRAPHY_LONGITUDE(expected.center) AS lon,
        GEOGRAPHY_LATITUDE(expected.center) AS lat,
        expected.diameter,
        pipelineName,
        (
          pipelines.pipeline_name IS NULL
          OR config_json::$connection_string NOT LIKE "%${scaleFactorPrefix}%"
        ) AS needsUpdate
      FROM (
        SELECT cities.*, CONCAT(prefix.table_col, cities.city_id) AS pipelineName
        FROM ${config.database}.cities
        JOIN TABLE(["locations_", "requests_", "purchases_"]) AS prefix
      ) AS expected
      LEFT JOIN information_schema.pipelines
        ON pipelines.database_name = ?
        AND pipelines.pipeline_name = expected.pipelineName
    `,
    config.database
  );
};

export const ensurePipelinesExist = async (
  config: ConnectionConfig,
  scaleFactor: ScaleFactor
) => {
  const scaleFactorPrefix = scaleFactor.prefix;
  const pipelines = await pipelineStatus(config, scaleFactor);

  await Promise.all(
    pipelines
      .filter((p) => p.needsUpdate)
      .map(async (pipeline) => {
        console.log(
          `recreating pipeline ${pipeline.pipelineName} for city ${pipeline.cityName}`
        );

        if (pipeline.pipelineName.startsWith("locations_")) {
          await Exec(
            config,
            `
            CREATE OR REPLACE PIPELINE ${pipeline.pipelineName}
            AS LOAD DATA LINK aws_s3 '${S3_BUCKET_NAME}/${scaleFactorPrefix}/locations.*'
            MAX_PARTITIONS_PER_BATCH ${scaleFactor.partitions}
            INTO PROCEDURE process_locations FORMAT PARQUET (
              subscriber_id <- subscriberid,
              @offset_x <- offsetX,
              @offset_y <- offsetY
            )
            SET
              city_id = ?,
              lonlat = GEOGRAPHY_POINT(
                ? + (@offset_x * ?),
                ? + (@offset_y * ?)
              )
          `,
            pipeline.cityId,
            pipeline.lon,
            pipeline.diameter,
            pipeline.lat,
            pipeline.diameter
          );
        } else if (pipeline.pipelineName.startsWith("requests_")) {
          await Exec(
            config,
            `
            CREATE OR REPLACE PIPELINE ${pipeline.pipelineName}
            AS LOAD DATA LINK aws_s3 '${S3_BUCKET_NAME}/${scaleFactorPrefix}/requests.*'
            MAX_PARTITIONS_PER_BATCH ${scaleFactor.partitions}
            INTO TABLE requests FORMAT PARQUET (
              subscriber_id <- subscriberid,
              domain <- domain
            )
            SET ts = NOW(),
              city_id = ?;
          `,
            pipeline.cityId
          );
        } else if (pipeline.pipelineName.startsWith("purchases_")) {
          await Exec(
            config,
            `
            CREATE OR REPLACE PIPELINE ${pipeline.pipelineName}
            AS LOAD DATA LINK aws_s3 '${S3_BUCKET_NAME}/${scaleFactorPrefix}/purchases.*'
            MAX_PARTITIONS_PER_BATCH ${scaleFactor.partitions}
            INTO TABLE purchases FORMAT PARQUET (
              subscriber_id <- subscriberid,
              vendor <- vendor
            )
            SET ts = NOW(),
              city_id = ?;
          `,
            pipeline.cityId
          );
        }

        await Exec(
          config,
          `ALTER PIPELINE ${pipeline.pipelineName} SET OFFSETS EARLIEST DROP ORPHAN FILES`
        );
        await Exec(
          config,
          `START PIPELINE IF NOT RUNNING ${pipeline.pipelineName}`
        );

        console.log(
          `finished creating pipeline ${pipeline.pipelineName} for city ${pipeline.cityName}`
        );
      })
  );
};

export const ensurePipelinesAreRunning = async (config: ConnectionConfig) => {
  const pipelines = await QueryTuples(
    config,
    `
      SELECT
        pipelines.pipeline_name,
        pipelines.state,
        SUM(file_state = "Loaded"):>int AS num_loaded,
        COUNT(file_state) AS num_total
      FROM information_schema.pipelines
      LEFT JOIN information_schema.pipelines_files ON (
        pipelines_files.pipeline_name = pipelines.pipeline_name
        AND pipelines_files.database_name = pipelines.database_name
      )
      WHERE pipelines.database_name = ? AND pipelines.pipeline_name != "worldcities"
      GROUP BY pipelines.pipeline_name
      HAVING num_loaded = num_total OR state != "Running"
    `,
    config.database
  );

  await Promise.all(
    pipelines.map(async ([name]) => {
      console.log("restarting pipeline", name);
      await Exec(
        config,
        `ALTER PIPELINE ${name} SET OFFSETS EARLIEST DROP ORPHAN FILES`
      );
      await Exec(config, `START PIPELINE IF NOT RUNNING ${name}`);
    })
  );
};

export const dropExtraPipelines = async (config: ConnectionConfig) => {
  const extraPipelines = await Query<{ pipelineName: string }>(
    config,
    `
      SELECT pipeline_name AS pipelineName
      FROM information_schema.pipelines
      WHERE
        database_name = ?
        AND pipelineName NOT IN (
          SELECT CONCAT(prefix.table_col, cities.city_id)
          FROM ${config.database}.cities
          JOIN TABLE(["locations_", "requests_", "purchases_"]) AS prefix
        )
        AND pipelineName != "worldcities"
    `,
    config.database
  );

  await Promise.all(
    extraPipelines.map((pipeline) => {
      console.log("dropping pipeline", pipeline.pipelineName);
      return Exec(config, `DROP PIPELINE ${pipeline.pipelineName}`);
    })
  );
};

// returns true if any plans were dropped
export const checkPlans = async (config: ConnectionConfig) => {
  const badPlans = await Query<{ planId: string }>(
    config,
    `
      SELECT plan_id AS planId
      FROM information_schema.plancache
      WHERE
        plan_warnings LIKE "%empty tables%"
    `
  );

  await Promise.all(
    badPlans.map(({ planId }) => Exec(config, `DROP ${planId} FROM PLANCACHE`))
  );

  return badPlans.length > 0;
};

/*
// We only need to count the metrics from the agreggators. The rows will always
// pass through an aggregator, so a row will be counted once in the leaf and
// once in the aggregator.
export const SQL_CLUSTER_THROUGHPUT = `
    SELECT 
        VARIABLE_NAME AS variableName, 
        SUM(cast(VARIABLE_VALUE as UNSIGNED)) AS variableValue, 
        NOW(6) AS readTime
    FROM
        INFORMATION_SCHEMA.MV_GLOBAL_STATUS 
    WHERE 
        (
            variable_name = 'Rows_affected_by_writes' OR
            variable_name = 'Rows_returned_by_reads'
        ) AND 
        (
            NODE_TYPE = 'MA' OR
            NODE_TYPE = 'CA'
        )
    GROUP BY
        VARIABLE_NAME;
`;

*/

export const estimatedRowCount = <TableName extends string>(
  config: ConnectionConfig,
  ...tables: TableName[]
) => {
  const tablesSQL = tables.map((name) => `"${name}"`).join(",");

  return QueryNoDb<{ tableName: TableName; count: number }>(
    config,
    `
      SELECT tableName, MAX(count) :> BIGINT AS count
      FROM (
        SELECT
          table_name AS tableName,
          SUM(rows) AS count
        FROM information_schema.table_statistics stats
        INNER JOIN information_schema.mv_nodes nodes ON (
          stats.host = nodes.ip_addr
          AND stats.port = nodes.port
        )
        WHERE
          (
            partition_type = "Master"
            OR (
              partition_type = "Reference" AND nodes.type = "MA"
            )
          )
          AND database_name = ?
          AND table_name IN (${tablesSQL})
        GROUP BY table_name
        UNION ALL
        SELECT table_col AS tableName, 0 AS count
        FROM TABLE([${tablesSQL}])
      )
      GROUP BY tableName
    `,
    config.database
  );
};

export const estimatedRowCountObj = <TableName extends string>(
  config: ConnectionConfig,
  ...tables: TableName[]
) =>
  estimatedRowCount(config, ...tables).then((rows) =>
    rows.reduce((acc, { tableName, count }) => {
      acc[tableName] = count;
      return acc;
    }, {} as { [name in TableName]: number })
  );

export const truncateTimeseriesTables = async (
  config: ConnectionConfig,
  scaleFactor: ScaleFactor
) => {
  const { maxRows } = scaleFactor;
  const tables = [
    "locations",
    "requests",
    "purchases",
    "notifications",
  ] as const;
  const tablesSQL = tables.map((name) => `"${name}"`).join(",");

  const oversizedTables = await QueryNoDb<{
    tableName: typeof tables[number];
    minTs: number;
    maxTs: number;
    count: number;
  }>(
    config,
    `
      SELECT
        stats.table_name AS tableName,
        stats.count,
        UNIX_TIMESTAMP(minmax.minTs) AS minTs,
        UNIX_TIMESTAMP(minmax.maxTs) AS maxTs
      FROM
        (
          SELECT database_name, table_name, SUM(rows) AS count
          FROM information_schema.table_statistics
          WHERE
            database_name = ?
            AND table_name IN (${tablesSQL})
            AND partition_type = "Master"
          GROUP BY database_name, table_name
        ) stats,
        (
          SELECT
            database_name, table_name,
            MIN(min_value) AS minTs,
            MAX(max_value) AS maxTs
          FROM information_schema.columnar_segments
          WHERE column_name = "ts"
          GROUP BY database_name, table_name
        ) minmax
      WHERE
        stats.database_name = minmax.database_name
        AND stats.table_name = minmax.table_name
        AND stats.count > ?
    `,
    config.database,
    maxRows
  );

  await Promise.all(
    oversizedTables.map(async ({ tableName, count, minTs, maxTs }) => {
      // calculate % of count to remove
      const delta = count - maxRows;
      const deltaPercent = delta / count;

      if (deltaPercent < 0.2) {
        return;
      }

      const ts = new Date((minTs + deltaPercent * (maxTs - minTs)) * 1000);
      console.log(
        `removing rows from ${tableName} older than ${ts.toISOString()}`
      );
      await Exec(
        config,
        `DELETE FROM ${tableName} WHERE ts <= ?`,
        ts.toISOString()
      );
    })
  );
};

export type SQLIntervals =
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month";

// returns number of notifications sent
export const runMatchingProcess = (
  config: ConnectionConfig,
  interval: SQLIntervals = "minute"
) =>
  QueryOne<{ RESULT: number }>(
    config,
    "ECHO run_matching_process(?)",
    interval
  ).then((x) => x.RESULT);

// returns the timestamp to use in the next call to runUpdateSegments
export const runUpdateSegments = async (
  config: ConnectionConfig,
  since: string
) => {
  const nowISO = new Date().toISOString();

  await Promise.all(
    [
      "update_location_segments",
      "update_request_segments",
      "update_purchase_segments",
    ].map((procedure) => Exec(config, `CALL ${procedure}(?, ?)`, since, nowISO))
  );

  await Exec(config, "CALL prune_segments(?)", nowISO);

  return nowISO;
};

export type NotificationTuple = [ts: string, lon: number, lat: number];

export const queryNotificationsInBounds = (
  config: ConnectionConfig,
  since: string,
  limit: number,
  bounds: Bounds
) =>
  QueryTuples<NotificationTuple>(
    config,
    `
      SELECT
        ts,
        GEOGRAPHY_LONGITUDE(lonlat) AS lon,
        GEOGRAPHY_LATITUDE(lonlat) AS lat
      FROM notifications
      WHERE
        ts > ?
        AND GEOGRAPHY_CONTAINS(?, lonlat)
      ORDER BY ts DESC
      LIMIT ${limit}
    `,
    since,
    boundsToWKTPolygon(bounds)
  );

export type Offer = {
  offerId: number;
  notificationZone: string;
};

export const queryOffersInBounds = (
  config: ConnectionConfig,
  limit: number,
  bounds: Bounds
) =>
  Query<Offer>(
    config,
    `
      SELECT
        offer_id AS offerId,
        notification_zone AS notificationZone
      FROM offers
      WHERE GEOGRAPHY_INTERSECTS(?, notification_zone)
      LIMIT ${limit}
    `,
    boundsToWKTPolygon(bounds)
  );

export type City = {
  id: number;
  name: string;
  centerLat: number;
  centerLon: number;
  diameter: number;
};

export const getCities = (config: ConnectionConfig) =>
  Query<City>(
    config,
    `
      SELECT
        city_id AS id,
        city_name AS name,
        GEOGRAPHY_LATITUDE(center) AS centerLat,
        GEOGRAPHY_LONGITUDE(center) AS centerLon,
        diameter
      FROM cities
    `
  );

export const lookupClosestCity = (
  config: ConnectionConfig,
  lon: number,
  lat: number
) =>
  QueryOne<City>(
    config,
    `
      SELECT
        city_id AS id,
        city_name AS name,
        GEOGRAPHY_LATITUDE(center) AS centerLat,
        GEOGRAPHY_LONGITUDE(center) AS centerLon,
        0.1 AS diameter
      FROM worldcities
      ORDER BY GEOGRAPHY_DISTANCE(center, GEOGRAPHY_POINT(?, ?)) ASC
      LIMIT 1
    `,
    lon,
    lat
  );
