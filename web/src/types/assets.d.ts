declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.json' {
  const value: { version?: string; [key: string]: unknown };
  export default value;
}

declare module '*.webm' {
  const src: string;
  export default src;
}

declare module '*.woff2' {
  const src: string;
  export default src;
}
