import fs from "node:fs/promises";

const formatJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await fs.writeFile(filePath, formatJson(value), "utf8");
};

export const writePrivateJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await writeJsonFile(filePath, value);
  await fs.chmod(filePath, 0o600);
};
