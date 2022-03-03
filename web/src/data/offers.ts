import { ConnectionConfig, Exec } from "@/data/client";
import { MultiReplace } from "@/data/sqlbuilder";
import { boundsToWKTPolygon } from "@/geo";
import VENDORS from "@/static-data/vendors.json";
import OpenLocationCode from "open-location-code-typescript";
import { Bounds, Point } from "pigeon-maps";
import stringHash from "string-hash";

export const DEFAULT_CUSTOMER_ID = 0;

export const DEFAULT_CITY = {
  name: "New York",
  lonlat: [-73.993562, 40.727063] as Point,
  diameter: 0.15,
};

const MAX_OFFERS_PER_BATCH = 500;

export type CityConfig = {
  name: string;
  lonlat: Point;
  diameter: number;
};

export const createCity = (config: ConnectionConfig, city: CityConfig) =>
  Exec(
    config,
    `
      INSERT INTO cities (city_name, center, diameter)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
        center = VALUES(center),
        diameter = VALUES(diameter)
    `,
    city.name,
    `POINT(${city.lonlat[0]} ${city.lonlat[1]})`,
    city.diameter
  );

export const SegmentKinds = ["olc_8", "olc_6", "purchase", "request"] as const;
export type SegmentKind = typeof SegmentKinds[number];

export const SegmentIntervals = [
  "minute",
  "hour",
  "day",
  "week",
  "month",
] as const;
export type SegmentInterval = typeof SegmentIntervals[number];

export type Segment = {
  interval: SegmentInterval;
  kind: SegmentKind;
  value: string;
};

export const segmentId = ({ interval, kind, value }: Segment) =>
  stringHash(`${interval}-${kind}-${value}`);

export const createSegments = async (
  config: ConnectionConfig,
  segments: Segment[]
) => {
  const stmt = new MultiReplace("segments", [
    "segment_id",
    "valid_interval",
    "filter_kind",
    "filter_value",
  ]);

  for (const segment of segments) {
    stmt.append(
      segmentId(segment),
      segment.interval,
      segment.kind,
      segment.value
    );
  }

  await Exec(config, stmt.sql(), ...stmt.params());
};

export type Offer = {
  segments: Segment[];

  // should be a WKT polygon
  notificationZone: string;

  notificationContent: string;
  notificationTarget: string;
  maximumBidCents: number;
};

export const createOffers = async (
  config: ConnectionConfig,
  offers: Offer[],
  customerId: number = DEFAULT_CUSTOMER_ID
) => {
  const stmt = new MultiReplace("offers", [
    "customer_id",
    "notification_zone",
    "segment_ids",
    "notification_content",
    "notification_target",
    "maximum_bid_cents",
  ]);

  let numOffers = 0;
  let segments: Segment[] = [];

  const commitBatch = async () => {
    await Promise.all([
      Exec(config, stmt.sql(), ...stmt.params()),
      createSegments(config, segments),
    ]);

    stmt.clear();
    segments = [];
    numOffers = 0;
  };

  for (const offer of offers) {
    stmt.append(
      customerId,
      offer.notificationZone,
      JSON.stringify(offer.segments.map(segmentId)),
      offer.notificationContent,
      offer.notificationTarget,
      offer.maximumBidCents
    );

    numOffers++;
    segments = segments.concat(offer.segments);

    if (numOffers >= MAX_OFFERS_PER_BATCH) {
      await commitBatch();
    }
  }

  if (numOffers > 0) {
    await commitBatch();
  }
};

const randomChoice = <T>(arr: readonly T[]): T =>
  arr[Math.floor(Math.random() * arr.length)];

const randomFloatInRange = (min: number, max: number) =>
  Math.random() * (max - min) + min;

const randomIntegerInRange = (min: number, max: number) =>
  Math.floor(randomFloatInRange(min, max));

const randomVendor = () => randomChoice(VENDORS);
const randomSegmentKind = () => randomChoice(SegmentKinds);
const randomSegmentInterval = () => randomChoice(SegmentIntervals);

const vendorDomain = ({ vendor, tld }: typeof VENDORS[number]) =>
  `${vendor.toLowerCase()}.${tld}`;

const randomPointInCity = (city: CityConfig): Point => {
  const [lon, lat] = city.lonlat;
  const radius = city.diameter / 2;
  const [minLon, maxLon] = [lon - radius, lon + radius];
  const [minLat, maxLat] = [lat - radius, lat + radius];
  return [
    randomFloatInRange(minLon, maxLon),
    randomFloatInRange(minLat, maxLat),
  ];
};

export const randomSegment = (city: CityConfig): Segment => {
  const kind = randomSegmentKind();
  const interval = randomSegmentInterval();
  switch (kind) {
    case "olc_8":
    case "olc_6": {
      const [lon, lat] = randomPointInCity(city);
      const olcLen = kind === "olc_8" ? 8 : 6;
      const olc = OpenLocationCode.encode(lat, lon, olcLen).substring(
        0,
        olcLen
      );
      return {
        kind,
        interval,
        value: olc,
      };
    }
    case "purchase":
      return {
        kind,
        interval,
        value: randomVendor().vendor,
      };
    case "request":
      return {
        kind,
        interval,
        value: vendorDomain(randomVendor()),
      };
  }
};

export const randomOffer = (city: CityConfig): Offer => {
  const numSegments = randomIntegerInRange(1, 3);
  const segments = Array.from({ length: numSegments }, () =>
    randomSegment(city)
  );

  const vendor = randomVendor();
  const domain = vendorDomain(vendor);
  const pctOff = randomIntegerInRange(10, 50);
  const vendorOfferId = randomIntegerInRange(1, 1000);
  const notificationContent = `${pctOff}% off at ${vendor.vendor}`;
  const notificationTarget = `https://${domain}/s2cellular?offerId=${vendorOfferId}`;

  const [lon, lat] = randomPointInCity(city);
  const olc = OpenLocationCode.encode(lat, lon, randomChoice([8, 10]));
  const area = OpenLocationCode.decode(olc);
  const bounds = {
    ne: [area.latitudeHi, area.longitudeHi],
    sw: [area.latitudeLo, area.longitudeLo],
  } as Bounds;

  return {
    segments,
    notificationZone: boundsToWKTPolygon(bounds),
    notificationContent,
    notificationTarget,
    maximumBidCents: randomIntegerInRange(2, 15),
  };
};

export const randomOffers = (city: CityConfig, numOffers: number) =>
  Array.from({ length: numOffers }, () => randomOffer(city));
