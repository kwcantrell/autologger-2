import { useMemo, useState } from 'react';
import { useProfile } from '../../../api/hooks/useProfile';
import type { EventGenerateSelection, ShowCategory } from '../../../api/types';
import { Dialog } from '../../../shared/ui/Dialog';

interface Props {
  showId: string | null;
  onSubmit: (selection: EventGenerateSelection[]) => void;
  onClose: () => void;
}

interface Candidate {
  key: string;
  categoryId: string;
  categoryLabel: string;
  optionLabel?: string;
  instruction: string;
}

function selectionCandidates(categories: ShowCategory[]): Candidate[] {
  return categories.flatMap((category) => {
    if (category.type === 'ON_OFF') return [];
    const categoryLabel = category.name || category.label || category.id;
    const buttonInstruction = category.auto_instruction?.trim();
    const button: Candidate[] = buttonInstruction
      ? [
          {
            key: JSON.stringify([category.id, null]),
            categoryId: category.id,
            categoryLabel,
            instruction: buttonInstruction,
          },
        ]
      : [];
    const options =
      category.type === 'DROPDOWN'
        ? category.dropdown_options.flatMap((option): Candidate[] => {
            const instruction = option.auto_instruction?.trim();
            const optionLabel = option.label.trim();
            return instruction && optionLabel
              ? [
                  {
                    key: JSON.stringify([category.id, optionLabel]),
                    categoryId: category.id,
                    categoryLabel,
                    optionLabel,
                    instruction,
                  },
                ]
              : [];
          })
        : [];
    return [...button, ...options];
  });
}

export function EventGenerateCustomModal({ showId, onSubmit, onClose }: Props) {
  const { data: profile } = useProfile();
  const categories = profile?.shows.find((show) => show.id === showId)?.categories ?? [];
  const candidates = useMemo(() => selectionCandidates(categories), [categories]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  function toggle(key: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function submit() {
    const selection = candidates.flatMap((candidate): EventGenerateSelection[] =>
      selected.has(candidate.key)
        ? [
            {
              category_id: candidate.categoryId,
              ...(candidate.optionLabel === undefined
                ? {}
                : { option_label: candidate.optionLabel }),
            },
          ]
        : [],
    );
    if (selection.length > 0) onSubmit(selection);
  }

  const grouped = candidates.reduce<Map<string, Candidate[]>>((groups, candidate) => {
    const group = groups.get(candidate.categoryId) ?? [];
    group.push(candidate);
    groups.set(candidate.categoryId, group);
    return groups;
  }, new Map());

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Custom event generation"
      description="Choose the button and option instructions to use for this generation run."
      className="md:!w-[min(38rem,96vw)]"
    >
      <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
        {[...grouped.values()].map((group) => (
          <fieldset
            key={group[0].categoryId}
            className="rounded-v5-sm border border-v5-border px-3 py-2"
          >
            <legend className="px-1 text-[0.85rem] font-semibold text-v5-text">
              {group[0].categoryLabel}
            </legend>
            <div className="flex flex-col gap-2">
              {group.map((candidate) => {
                const label = candidate.optionLabel ?? 'Button instruction';
                return (
                  <label
                    key={candidate.key}
                    className="flex cursor-pointer items-start gap-2 text-[0.82rem] text-v5-text"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.key)}
                      onChange={(event) => toggle(candidate.key, event.target.checked)}
                    />
                    <span>
                      <span className={candidate.optionLabel ? 'pl-3 font-medium' : 'font-medium'}>
                        {label}
                      </span>
                      <span className="mt-0.5 block text-[0.76rem] text-v5-muted">
                        {candidate.instruction}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={selected.size === 0}
          onClick={submit}
        >
          Generate
        </button>
      </div>
    </Dialog>
  );
}
