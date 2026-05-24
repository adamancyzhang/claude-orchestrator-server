import { Box, Text as InkText } from "ink";

interface Props {
  leaderName: string;
  magicMode: boolean;
  magicMaxChains: number | null;
}

export default function Footer({
  leaderName,
  magicMode,
  magicMaxChains,
}: Props) {
  return (
    <Box flexDirection="row">
      <InkText dimColor>Leader: {leaderName}</InkText>
      {magicMode ? (
        <InkText>
          {" "}
          <InkText bold>[MAGIC]</InkText>
          <InkText dimColor>
            (max={magicMaxChains ?? "∞"})
          </InkText>
        </InkText>
      ) : null}
      <InkText dimColor> | Tab=next worker | [/]=page | 1-9 jump | Ctrl+C quit</InkText>
    </Box>
  );
}
