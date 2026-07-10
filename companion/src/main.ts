import type { JsonObject } from '@companion-module/base';
import { InstanceBase, type InstanceTypes, type SomeCompanionConfigField } from '@companion-module/base';

// NOTE: @companion-module/base 2.0.x removed `runEntrypoint` — the pinned
// range (~2.0.0, currently resolving to 2.0.4) expects a default export of
// the instance class instead (see that package's CHANGELOG, 2.0.0-alpha.0:
// "remove runEntrypoint method, expect default export instead"). This stub
// is replaced wholesale in Task 8; flagged here since it deviates from the
// task-1 brief's verbatim (1.x-shaped) code, which does not typecheck
// against the pinned 2.0.x API.
//
// Also note: InstanceBase's TManifest['config'] must satisfy JsonObject
// (an indexable type). Task 2's `ModuleConfig` (config.ts) will need the
// same treatment — flagged in the task-1 report, not fixed ahead of time.

interface ModuleConfig extends JsonObject {
  url: string;
  token: string;
  pollMs: number;
}

interface AutologgerInstanceTypes extends InstanceTypes {
  config: ModuleConfig;
}

class AutologgerInstance extends InstanceBase<AutologgerInstanceTypes> {
  async init(_config: ModuleConfig): Promise<void> {}
  async destroy(): Promise<void> {}
  async configUpdated(_config: ModuleConfig): Promise<void> {}
  getConfigFields(): SomeCompanionConfigField[] {
    return [];
  }
}

export default AutologgerInstance;
