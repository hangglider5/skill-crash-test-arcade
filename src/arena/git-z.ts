export interface GitPathRecord {
  readonly code: string;
  readonly paths: readonly string[];
}

function nulFields(output: string): string[] {
  if (output.length === 0) {
    return [];
  }
  if (!output.endsWith("\0")) {
    throw new Error("Git -z output is missing its final NUL terminator");
  }
  return output.slice(0, -1).split("\0");
}

export function parsePorcelainV1Z(output: string): GitPathRecord[] {
  const fields = nulFields(output);
  const records: GitPathRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4 || field[2] !== " ") {
      throw new Error("Malformed git status --porcelain=v1 -z record");
    }
    const code = field.slice(0, 2);
    const paths = [field.slice(3)];
    if (/[RC]/.test(code)) {
      const originalPath = fields[index + 1];
      if (originalPath === undefined) {
        throw new Error("Git rename/copy status record is missing its original path");
      }
      paths.push(originalPath);
      index += 1;
    }
    records.push({ code, paths });
  }
  return records;
}

export function parseNameStatusZ(output: string): GitPathRecord[] {
  const fields = nulFields(output);
  const records: GitPathRecord[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (code === undefined || !/^[ACDMRTUXB][0-9]*$/.test(code)) {
      throw new Error("Malformed git diff --name-status -z status code");
    }
    const pathCount = /^[RC]/.test(code) ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (paths.length !== pathCount || paths.some((changedPath) => changedPath.length === 0)) {
      throw new Error("Malformed git diff --name-status -z path record");
    }
    records.push({ code, paths });
    index += pathCount;
  }
  return records;
}
