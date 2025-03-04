import { ChevronDownIcon } from "@chakra-ui/icons";
import {
  Box,
  Container,
  Flex,
  Grid,
  GridItem,
  Heading,
  Icon,
  Progress,
  Stack,
  Stat,
  StatHelpText,
  StatLabel,
  StatNumber,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useColorModeValue,
  useMediaQuery,
} from "@chakra-ui/react";
import { format } from "d3-format";
import { interpolateRgb } from "d3-interpolate";
import { Bounds } from "pigeon-maps";
import * as React from "react";
import { IconType } from "react-icons";
import { BsGearFill, BsPerson } from "react-icons/bs";
import { HiBell, HiCalendar, HiCurrencyDollar, HiOfficeBuilding, HiOutlineBell, HiOutlineCalendar, HiOutlineCurrencyDollar, HiOutlineUser, HiPhone, HiRefresh, HiUser } from "react-icons/hi";
import { useRecoilValue } from "recoil";
import useSWR from "swr";

import { Loader } from "@/components/customcomponents/loader/Loader";
import { EnableSimulatorWarning } from "@/components/EnableSimulatorButton";
import { Heatmap } from "@/components/HeatMap";
import { SetupDatabaseButton } from "@/components/SetupDatabaseButton";
import {
  costMetrics,
  CostMetrics,
  CustomerMetrics,
  customerMetrics,
  estimatedRowCountObj,
  overallConversionRate,
  ZoneMetrics,
  zoneMetrics,
} from "@/data/queries";
import { connectionConfig, simulatorEnabled } from "@/data/recoil";
import { useConnectionState } from "@/view/hooks/hooks";
import { useSimulationMonitor } from "@/view/hooks/useSimulationMonitor";
import { useSimulator } from "@/view/hooks/useSimulator";

const formatPct = format(",.2%");
const formatStat = format(".4~s");

const NotificationZoneMap = () => {
  const [isSmallScreen] = useMediaQuery("(max-width: 640px)");

  return (
    <Flex gap={5} direction={isSmallScreen ? "column" : "row"}>
      <Stack flex={2}>
        <StatGrid />
      </Stack>
      <Box
        padding="17px"
        flex={4}
        borderRadius={10}
        border="1px solid grey"
        position="relative"
      >
        <Flex
          direction="row"
          justifyContent="space-between"
          width="100%"
          gap={10}
          alignItems="center"
        >
          <Text fontWeight="bold" fontSize="sm" textTransform="uppercase">
            Offer conversion rates by Notification zone
          </Text>
          <Flex width="30%" direction="column">
            <Box width="100%">
              <Progress
                colorScheme="transparent"
                height={2}
                bgGradient="linear(to-r, #3A249E 0%, #CCC3F9 100%)"
                value={90}
              />
            </Box>
            <Flex width="100%" justifyContent="space-between">
              <Text>
                <small>High</small>
              </Text>
              <Text>
                <small>Low</small>
              </Text>
            </Flex>
          </Flex>
        </Flex>
        <br />

        <Heatmap
          height={400}
          useCells={useConversionCells}
          colorInterpolater={interpolateRgb("#CCC3F9", "#3A249E")}
          getCellConfig={({ conversionRate, wktPolygon }: ZoneMetrics) => ({
            value: conversionRate,
            wktPolygon,
          })}
        />
      </Box>
    </Flex>
  );
};

const DashboardContainerChild = () => {
  const { initialized, connected } = useConnectionState();
  const enabled = useRecoilValue(simulatorEnabled);
  useSimulationMonitor(enabled);
  useSimulator(enabled);

  if (!connected) {
    window.location.href = "/";
  }

  if (!initialized) {
    return <SetupDatabaseButton />;
  } else if (enabled) {
    return <EnableSimulatorWarning />;
  }
  return (
    <Stack gap={10}>
      <Stack spacing={3}>
        <Stack spacing={2}>
          <Heading fontSize="xl">Engagement</Heading>
          <Text overflowWrap="break-word">
            Conversion rate with subscribers
          </Text>
        </Stack>
        <NotificationZoneMap />
      </Stack>
      <Stack spacing={3}>
        <Stack spacing={2}>
          <Heading fontSize="xl">Top Performing Customers</Heading>
          <Text overflowWrap="break-word">
            Companies with the highest conversion rate
          </Text>
        </Stack>
        <ConversionTable />
      </Stack>
            <Stack spacing={3}>
        <Stack spacing={2}>
          <Heading fontSize="xl">Latest Notifications</Heading>
          <Text overflowWrap="break-word">
            Latest offers & cost per notification
          </Text>
        </Stack>
        <CostsTable />
      </Stack>
    </Stack>
  );
};

const StatGrid = () => {
  const config = useRecoilValue(connectionConfig);

  const overallRateRequests = useSWR(
    ["overallConversionRateRequests", config],
    () => overallConversionRate(config, "requests"),
    { refreshInterval: 1000 }
  );
  const overallRatePurchases = useSWR(
    ["overallConversionRatePurchases", config],
    () => overallConversionRate(config, "purchases"),
    { refreshInterval: 1000 }
  );

  const tableCounts = useSWR(
    ["analyticsTableCounts", config],
    () =>
      estimatedRowCountObj(config, "offers", "subscribers", "notifications"),
    { refreshInterval: 1000 }
  );

  if (
    !tableCounts.data ||
    !overallRateRequests.data ||
    !overallRatePurchases.data
  ) {
    return <Loader size="small" centered />;
  }

  return (
    <Grid gap={2} templateColumns="repeat(2, 1fr)">
      <StatWrapper
        statLabel="Offers"
        statNumber={formatStat(tableCounts.data.offers)}
        colSpan={2}
      />
      <StatWrapper
        statLabel="Subscribers"
        statNumber={formatStat(tableCounts.data.subscribers)}
      />
      <StatWrapper
        statLabel="Notifications"
        statNumber={formatStat(tableCounts.data.notifications)}
      />
      <StatWrapper
        statLabel="Conversion Rate"
        statNumber={formatPct(overallRateRequests.data?.conversionRate || 0)}
        helpText="Requests"
      />
      <StatWrapper
        statLabel="Conversion Rate"
        statNumber={formatPct(overallRatePurchases.data?.conversionRate || 0)}
        helpText="Purchases"
      />
    </Grid>
  );
};

const ConversionTable = () => {
  const config = useRecoilValue(connectionConfig);
  const [sortColumn, setSortColumn] =
    React.useState<keyof CustomerMetrics>("conversionRate");

  const metricsTableData = useSWR(
    ["customerMetrics", config, sortColumn],
    () => customerMetrics(config, "purchases", sortColumn, 10),
    { refreshInterval: 1000 }
  );
  const activeColor = useColorModeValue("#553ACF", "#CCC3F9");
  const cellLeftPadding = "10px";

  const getTableBody = () => {
    if (metricsTableData.isValidating && !metricsTableData.data) {
      return (
        <Tr>
          <Td colSpan={4}>
            <Loader size="small" centered />
          </Td>
        </Tr>
      );
    } else if (!metricsTableData.data) {
      return (
        <Tr>
          <Td colSpan={4}>
            <Text display="flex" justifyContent="center" width="100%">
              No data
            </Text>
          </Td>
        </Tr>
      );
    }

    return metricsTableData.data?.map((c) => (
      <Tr key={c.customer}>
        <Td>{c.customer}</Td>
        <Td paddingLeft={cellLeftPadding}>
          {formatStat(c.totalNotifications)}
        </Td>
        <Td paddingLeft={cellLeftPadding}>{formatStat(c.totalConversions)}</Td>
        <Td paddingLeft={cellLeftPadding}>
          <Box
            background="white"
            display="inline-block"
            borderRadius="5px"
            padding={0}
            margin={0}
          >
            <Box
              display="inline-block"
              borderRadius="5px"
              padding="4px"
              fontSize="xs"
              background={`rgba(79, 52, 199, ${c.conversionRate + 0.03})`}
              color="rgba(0,0,0,1)"
            >
              {formatPct(c.conversionRate)}
            </Box>
          </Box>
        </Td>
      </Tr>
    ));
  };

  const THContentWrapper = ({
    sortColumnValue,
    icon,
    title,
  }: {
    sortColumnValue: React.SetStateAction<keyof CustomerMetrics>;
    icon: IconType;
    title: string;
  }) => {
    return (
      <Th
        onClick={() => setSortColumn(sortColumnValue)}
        _hover={{ color: activeColor }}
        padding={0}
        color={sortColumnValue === sortColumn ? activeColor : undefined}
        cursor="pointer"
      >
        <Box
          justifyContent="left"
          gap={2}
          alignItems="center"
          padding={cellLeftPadding}
          display="flex"
        >
          <Icon as={icon} />
          {title}
          {sortColumnValue === sortColumn ? <ChevronDownIcon /> : undefined}
        </Box>
      </Th>
    );
  };

  return (
    <Box overflowX="auto">
      <TableContainer>
        <Table size="sm" variant="striped">
          <Thead background={useColorModeValue("#ECE8FD", "#2F206E")}>
            <Tr>
              <THContentWrapper
                sortColumnValue="customer"
                icon={HiOfficeBuilding}
                title="Company"
              />
              <THContentWrapper
                sortColumnValue="totalNotifications"
                icon={HiBell}
                title="Total Notifications"
              />
              <THContentWrapper
                sortColumnValue="totalConversions"
                icon={HiRefresh}
                title="Total Conversions"
              />
              <THContentWrapper
                sortColumnValue="conversionRate"
                icon={BsGearFill}
                title="Conversion Rate"
              />
            </Tr>
          </Thead>
          <Tbody>{getTableBody()}</Tbody>
        </Table>
      </TableContainer>
    </Box>
  );
};

const CostsTable = () => {
  console.log("rendering...")
  const config = useRecoilValue(connectionConfig);
  const [sortColumn, setSortColumn] =
    React.useState<keyof CostMetrics>("timestamp");

  const [loading, setLoading] = React.useState(false);

  const handleSortColumn = (column) => {
    if (column === 'cost') {
      setLoading(true); 
    } else {
      setSortColumn(column);
    }
  };
  // Effect to handle delayed sorting
  React.useEffect(() => {
    let timeout;
    if (loading) {
      timeout = setTimeout(() => {
        setSortColumn('cost');
        setLoading(false);
      }, 4000); // Delay of 5 seconds
    }
    return () => clearTimeout(timeout); // Cleanup timeout on unmount
  }, [loading]);

  const costTableData = useSWR(
    ["costMetrics", config, sortColumn],
    () => costMetrics(config, sortColumn, 10),
    { refreshInterval: 1000 }
  );
  const activeColor = useColorModeValue("#553ACF", "#CCC3F9");
  const cellLeftPadding = "10px";

  const maxCost = Math.max(...costTableData.data?.map(offer => offer.cost) ?? [0]);
  const minCost = Math.min(...costTableData.data?.map(offer => offer.cost) ?? [0]);

  // Function to determine the background color based on cost
  const getCostColor = (cost: number, minCost: number, maxCost: number) => {
    const intensity = maxCost !== minCost ? (cost - minCost) / (maxCost - minCost) : 0;
    return `rgba(0, 128, 0, ${1 - intensity})`;
  };

  const getTableBody = () => {
    if (loading) {
      // Render loader in the middle of the table
      return (
        <Tr>
          <Td colSpan={5} style={{ textAlign: 'center' }}>
            <Loader size="small" centered />
          </Td>
        </Tr>
      );
    } else if (costTableData.isValidating && !costTableData.data) {
        return (
          <Tr>
            <Td colSpan={4}>
              <Loader size="small" centered />
            </Td>
          </Tr>
        );
      } else if (!costTableData.data) {
        return (
          <Tr>
            <Td colSpan={4}>
              <Text display="flex" justifyContent="center" width="100%">
                No data
              </Text>
            </Td>
          </Tr>
        );
      }
    
      return costTableData.data?.map((offer) => (
        <Tr key={`${offer.offerId}-${offer.subscriberId}-${offer.timestamp}-${offer.customer}`}>
          <Td>{offer.customer}</Td>
          <Td>{offer.timestamp}</Td>
          <Td>{offer.offerId}</Td>
          <Td>{offer.subscriberId}</Td>
          <Td paddingLeft={cellLeftPadding}>
            <Box
              background="white"
              display="inline-block"
              borderRadius="5px"
              padding={0}
              margin={0}
            >
              <Box
                display="inline-block"
                borderRadius="5px"
                padding="4px"
                fontSize="xs"
                background={getCostColor(offer.cost, minCost, maxCost)}
                color="rgba(0,0,0,1)"
              >
                {offer.cost}
              </Box>
            </Box>
          </Td>
        </Tr>
      ));
  };

  const THContentWrapper = ({
    sortColumnValue,
    icon,
    title,
  }: {
    sortColumnValue: React.SetStateAction<keyof CostMetrics>;
    icon: IconType;
    title: string;
  }) => {
    return (
      <Th
        onClick={() => handleSortColumn(sortColumnValue)}
        _hover={{ color: activeColor }}
        padding={0}
        color={sortColumnValue === sortColumn ? activeColor : undefined}
        cursor="pointer"
      >
        <Box
          justifyContent="left"
          gap={2}
          alignItems="center"
          padding={cellLeftPadding}
          display="flex"
        >
          <Icon as={icon} />
          {title}
          {sortColumnValue === sortColumn ? <ChevronDownIcon /> : undefined}
        </Box>
      </Th>
    );
  };

  return (
    <Box overflowX="auto">
      <TableContainer>
        <Table size="sm" variant="striped">
          <Thead background={useColorModeValue("#ECE8FD", "#2F206E")}>
            <Tr>
              <THContentWrapper
                sortColumnValue="customer"
                icon={HiOfficeBuilding}
                title="Company"
              />
              <THContentWrapper
                sortColumnValue="timestamp"
                icon={HiCalendar}
                title="Timestamp"
              />
              <THContentWrapper
                sortColumnValue="subscriberId"
                icon={HiUser}
                title="Subscriber ID"
              />
              <THContentWrapper
                sortColumnValue="offerId"
                icon={HiBell}
                title="Offer ID"
              />
              <THContentWrapper
                sortColumnValue="cost"
                icon={HiCurrencyDollar}
                title="Cost"
              />
            </Tr>
          </Thead>
          <Tbody>{getTableBody()}</Tbody>
        </Table>
      </TableContainer>
    </Box>
  );
};

const useConversionCells = (
  bounds: Bounds,
  callback: (cells: Array<ZoneMetrics>) => void
) => {
  const config = useRecoilValue(connectionConfig);
  useSWR(
    ["zoneMetrics", config, bounds],
    () => zoneMetrics(config, bounds, "purchases"),
    {
      refreshInterval: 1000,
      onSuccess: callback,
    }
  );
};

export const AnalyticsDashboard = () => {
  const [isSmallScreen] = useMediaQuery("(max-width: 640px)");

  return (
    <Container maxW={isSmallScreen ? undefined : "75%"} mt={10} mb="5%">
      <DashboardContainerChild />
    </Container>
  );
};

const StatWrapper = ({
  statLabel,
  statNumber,
  helpText,
  colSpan,
}: {
  statLabel: string;
  statNumber: string;
  helpText?: string;
  colSpan?: number;
}) => {
  let helpTextContainer;
  if (helpText) {
    helpTextContainer = <StatHelpText>{helpText}</StatHelpText>;
  }

  return (
    <GridItem
      padding="20px"
      background={useColorModeValue("#ECE8FD", "#2F206E")}
      borderRadius="15px"
      colSpan={colSpan || 1}
    >
      <Stat>
        <StatLabel>{statLabel}</StatLabel>
        <StatNumber color={useColorModeValue("#553ACF", "#CCC3F9")}>
          {statNumber}
        </StatNumber>
        {helpTextContainer}
      </Stat>
    </GridItem>
  );
};
