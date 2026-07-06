export function relativeFileKey(rootName, folderPath, fileName) {
  const prefix = `${rootName}/`;
  const rel = folderPath.startsWith(prefix) ? folderPath.slice(prefix.length) : folderPath;
  return rel ? `${rel}/${fileName}` : fileName;
}

export async function getFileByKey(dirHandle, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  let node = dirHandle;

  for (let i = 0; i < parts.length - 1; i++) {
    node = await node.getDirectoryHandle(parts[i]);
  }

  return node.getFileHandle(parts[parts.length - 1]);
}

export function extensionOf(nameOrPath) {
  return (nameOrPath.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
}
