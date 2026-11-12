import type { ReactNode } from 'react';
import type { AutogenerateStep, AutogenerateWikiMode } from '../../../../api/types';
import { Checkbox } from '../../../../shared/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../../../../shared/components/ui/field';
import { RadioGroup, RadioGroupItem } from '../../../../shared/components/ui/radio-group';
import { AUTOGENERATE_STEPS, WIKI_MODE_LABEL } from './autogenerateModel';

// --- Batch autogenerate Steps and Wiki output groups (playlist-import-autogenerate design D8) ---
//
// Controlled; rendered by Settings → Batch autogenerate and by the Batch Import modal's
// "Autogenerate after import" group. `idPrefix` keeps element ids unique when both are mounted.

interface AutogenerateOptionsProps {
  idPrefix: string;
  steps: ReadonlySet<AutogenerateStep>;
  onStepsChange: (next: Set<AutogenerateStep>) => void;
  mode: AutogenerateWikiMode;
  onModeChange: (mode: AutogenerateWikiMode) => void;
  disabled?: boolean;
}

export function AutogenerateOptions({
  idPrefix,
  steps,
  onStepsChange,
  mode,
  onModeChange,
  disabled = false,
}: AutogenerateOptionsProps) {
  const wikiDisabled = disabled || !steps.has('wiki');
  return (
    <>
      <FieldSet aria-label="Steps">
        <FieldLegend variant="label">Steps</FieldLegend>
        <FieldGroup data-slot="checkbox-group" className="gap-3">
          {AUTOGENERATE_STEPS.map((s) => {
            const id = `${idPrefix}-step-${s.id}`;
            return (
              <Field key={s.id} orientation="horizontal">
                <Checkbox
                  id={id}
                  aria-label={s.label}
                  checked={steps.has(s.id)}
                  disabled={disabled}
                  onCheckedChange={(next) => {
                    const set = new Set(steps);
                    if (next === true) set.add(s.id);
                    else set.delete(s.id);
                    onStepsChange(set);
                  }}
                />
                <FieldLabel htmlFor={id} className="font-normal">
                  {s.label}
                </FieldLabel>
              </Field>
            );
          })}
        </FieldGroup>
        <FieldDescription>
          Each step runs only where its output is missing; the wiki update runs on every session
          with a transcript.
        </FieldDescription>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Wiki output</FieldLegend>
        <RadioGroup
          aria-label="Wiki output"
          value={mode}
          onValueChange={(v) => onModeChange(v as AutogenerateWikiMode)}
          disabled={wikiDisabled}
          className="flex flex-col gap-2"
        >
          {(['accept', 'pending'] as const).map((value) => (
            <span key={value} className="flex items-center gap-2">
              <RadioGroupItem
                id={`${idPrefix}-wiki-${value}`}
                value={value}
                aria-label={WIKI_MODE_LABEL[value]}
                disabled={wikiDisabled}
              />
              <label htmlFor={`${idPrefix}-wiki-${value}`} className="text-sm">
                {WIKI_MODE_LABEL[value]}
              </label>
            </span>
          ))}
        </RadioGroup>
      </FieldSet>
    </>
  );
}

/**
 * The batch autogenerate confirm body: the caller's lead sentences, the own-accounts sentence,
 * the caller's trailing sentences, and in auto-accept mode with Wiki ticked the wiki warning.
 */
export function AutogenerateConfirmMessage({
  lead,
  trailing = [],
  mode,
  wiki,
}: {
  lead: readonly ReactNode[];
  trailing?: readonly ReactNode[];
  mode: AutogenerateWikiMode;
  wiki: boolean;
}) {
  return (
    <span className="flex flex-col gap-2">
      {lead.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list of sentences
        <span key={`lead-${i}`}>{s}</span>
      ))}
      <span>The work runs on your own provider accounts.</span>
      {trailing.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list of sentences
        <span key={`trailing-${i}`}>{s}</span>
      ))}
      {wiki && mode === 'accept' && (
        <span>
          AI-written new pages and additions will be added to wiki pages without review; rewrites
          that remove or change text stay as suggestions to review.
        </span>
      )}
    </span>
  );
}
