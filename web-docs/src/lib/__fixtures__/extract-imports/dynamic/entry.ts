import './styles.css';

export async function loadLazy() {
  const mod = await import('./lazy');
  return mod;
}

export async function loadDynamic(cond: boolean) {
  const specifier = cond ? './lazy' : './other';
  const mod = await import(specifier);
  return mod;
}
