import { readFileSync } from "node:fs";

// A raw ENOENT does not say which option named the file.
export function readOptionFile(option: string, path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error && "code" in error ? String(error.code) : "read failed";
    throw new Error(`Cannot read the file ${path} that ${option} names (${reason}). Check the path.`, { cause: error });
  }
}
