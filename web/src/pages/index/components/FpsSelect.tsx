import { LazySelect } from './LazySelect';
import type { SelectOption } from './Select';

const FPS_PRESETS: SelectOption[] = [
  { value: '23.976', label: '23.976 (2398/100)' },
  { value: '24', label: '24' },
  { value: '25', label: '25' },
  { value: '29.97', label: '29.97 (30000/1001)' },
  { value: '30', label: '30' },
  { value: '47.952', label: '47.952 (48000/1001)' },
  { value: '48', label: '48' },
  { value: '50', label: '50' },
  { value: '59.94', label: '59.94 (60000/1001)' },
  { value: '60', label: '60' },
  { value: '100', label: '100' },
  { value: '119.88', label: '119.88 (120000/1001)' },
  { value: '120', label: '120' },
];

function fpsToPresetValue(fps: number): string {
  for (const { value } of FPS_PRESETS) {
    if (Math.abs(fps - Number.parseFloat(value)) < 0.0001) return value;
  }
  return '24';
}

interface FpsSelectProps {
  value: number;
  onChange: (fps: number) => void;
  id?: string;
  className?: string;
}

export function FpsSelect({ value, onChange, id, className }: FpsSelectProps) {
  return (
    <LazySelect
      id={id}
      className={className}
      ariaLabel="Frame rate"
      value={fpsToPresetValue(value)}
      onChange={(next) => onChange(Number.parseFloat(next))}
      options={FPS_PRESETS}
    />
  );
}
