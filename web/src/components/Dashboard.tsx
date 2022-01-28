import { PixiMap } from "@/components/PixiMap";
import { useNotifications } from "@/data/useNotifications";
import { useNotificationsRenderer } from "@/render/notifications";
import {
  Box,
  Flex,
  Heading,
  HStack,
  Stack,
  Text,
  useColorModeValue,
} from "@chakra-ui/react";

type Notification = {
  offerID: string;
  costCents: number;
  lon: number;
  lat: number;
  content: string;
};

const Notification = (n: Notification) => (
  <Stack
    bg={useColorModeValue("gray.200", "gray.700")}
    borderRadius="md"
    p={4}
    spacing={2}
  >
    <Text isTruncated>{n.content}</Text>
    <HStack spacing={4}>
      <Box>
        <Text fontSize="xs">Offer</Text>
        <Text fontSize="sm" fontWeight="bold">
          {n.offerID}
        </Text>
      </Box>
      <Box>
        <Text fontSize="xs">Location</Text>
        <Text fontSize="sm" fontWeight="bold">
          {Math.abs(n.lat)} {n.lat < 0 ? "N" : "S"} {Math.abs(n.lon)}{" "}
          {n.lon < 0 ? "W" : "E"}
        </Text>
      </Box>
      <Box>
        <Text fontSize="xs">Cost</Text>
        <Text fontSize="sm" fontWeight="bold">
          ${(n.costCents / 100).toFixed(2)}
        </Text>
      </Box>
    </HStack>
  </Stack>
);

export const Dashboard = () => {
  const notificationEmitter = useNotifications();
  const renderer = useNotificationsRenderer(notificationEmitter);

  return (
    <Flex
      gap={4}
      justifyContent="space-between"
      direction={["column", "column", "row"]}
      height="100%"
    >
      <Stack spacing={4} flex="2 2 0" minHeight="200px" maxHeight="100%">
        <Heading size="md">Map</Heading>
        <PixiMap renderer={renderer} />
      </Stack>
      <Stack spacing={4} flex="1 1 0" minWidth="0">
        <Heading size="md">Notifications Stream</Heading>
        <Stack spacing={4}>
          <Notification
            {...{
              offerID: "123",
              costCents: 10,
              lon: 56.34,
              lat: -34.23,
              content: "beer, now 50% off",
            }}
          />
          <Notification
            {...{
              offerID: "342",
              costCents: 8,
              lon: -36.34,
              lat: 82.23,
              content:
                "free $20 gift card with purchase of $100asdf asdfjioqawjfewfjowijfoiwajfowjefwaef owe foi wefj wioefj weiof joi",
            }}
          />
        </Stack>
      </Stack>
    </Flex>
  );
};
