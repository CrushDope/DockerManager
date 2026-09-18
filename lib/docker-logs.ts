export type DockerLogStream = 'stdout' | 'stderr' | 'console';

export type DockerLogLine = {
  timestamp: string | null;
  stream: DockerLogStream;
  message: string;
};

// oxlint-disable-next-line no-control-regex
const ansi = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/s;

function clean(value: string) {
  return value.replace(ansi, '').split(String.fromCharCode(0)).join('');
}

function parseText(value: string, stream: DockerLogStream) {
  return clean(value)
    .split(/\r?\n/)
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .map<DockerLogLine>((line) => {
      const match = line.match(timestamp);
      return {
        timestamp: match?.[1] || null,
        stream,
        message: match?.[2] ?? line,
      };
    });
}

export function decodeDockerLogs(buffer: Buffer, tty: boolean) {
  if (!buffer.length) return [];
  if (tty) return parseText(buffer.toString('utf8'), 'console');

  const lines: DockerLogLine[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if ((stream !== 1 && stream !== 2) || size > buffer.length - offset - 8) {
      return parseText(buffer.toString('utf8'), 'console');
    }
    const content = buffer.subarray(offset + 8, offset + 8 + size).toString('utf8');
    lines.push(...parseText(content, stream === 2 ? 'stderr' : 'stdout'));
    offset += 8 + size;
  }
  if (offset !== buffer.length) return parseText(buffer.toString('utf8'), 'console');
  return lines;
}
