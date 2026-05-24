import { Box, Text as InkText } from "ink";

interface Props {
  buffer: string;
  pendingInput: string | null;
  sentAt: number | null;
  nowMs: number;
}

export default function InputLine({
  buffer,
  pendingInput,
  sentAt,
  nowMs,
}: Props) {
  const prompt = `> ${buffer}█`;

  let hint: string;
  if (pendingInput !== null && sentAt !== null) {
    const elapsed = nowMs - sentAt;
    if (elapsed < 2000) {
      return (
        <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <InkText>{prompt}</InkText>
          <InkText color="green">
            ✓ sent: {pendingInput}
          </InkText>
        </Box>
      );
    }
  }
  if (buffer.length === 0) {
    hint = "Type a message and press Enter to send";
  } else {
    hint = " ";
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <InkText>{prompt}</InkText>
      <InkText dimColor>{hint}</InkText>
    </Box>
  );
}
