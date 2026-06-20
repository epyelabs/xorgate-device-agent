import { Box, Text } from "ink";

/** Bordered titled section for the monitor grid (no focus arrow, unlike argus's
 * PanelFrame — the monitor shows all panels at once). */
export function Panel({
  title,
  children,
  color = "gray",
  width,
  flexGrow,
}: {
  title: string;
  children: React.ReactNode;
  color?: string;
  width?: number;
  flexGrow?: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      width={width}
      flexGrow={flexGrow}
    >
      <Text bold color={color === "gray" ? "white" : color}>
        {title}
      </Text>
      {children}
    </Box>
  );
}
