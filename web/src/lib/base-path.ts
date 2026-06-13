const viteBase = import.meta.env.BASE_URL || '/';

export const BASE_PATH =
  viteBase === '/' ? '' : viteBase.replace(/\/+$/, '');

export function appUrl(path = ''): string {
  const suffix = path.replace(/^\/+/, '');
  return `${BASE_PATH}/${suffix}`;
}

export function appAsset(path: string): string {
  return appUrl(path);
}
