const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }

  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return UTF8_DECODER.decode(buffer.subarray(0, end));
    } catch {
      continue;
    }
  }
  return "";
};
