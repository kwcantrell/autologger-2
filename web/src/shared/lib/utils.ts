import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names and resolves conflicting Tailwind utilities (later wins). The shadcn primitives' `cn`. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
