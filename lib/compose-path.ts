const segmentPattern = /^[a-zA-Z0-9_\-\u4e00-\u9fff][a-zA-Z0-9_.\-\u4e00-\u9fff]*$/;

export function validateComposeDirectory(directory: string) {
  const normalized = directory.trim().replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (!normalized || parts.some((part) => !segmentPattern.test(part) || part === '..')) {
    throw new Error('保存位置必须是 /composeFile 下的有效子目录');
  }
  return normalized;
}
