import { CopyIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, Fragment, useState } from 'react';
import {
  useCompanionDevices,
  useCreateCompanionDevice,
  useRevokeCompanionDevice,
} from '../../../../api/hooks/useCompanionDevices';
import type { CompanionDevice } from '../../../../api/types';
import { Alert, AlertDescription } from '../../../../shared/components/ui/alert';
import { Badge } from '../../../../shared/components/ui/badge';
import { Button } from '../../../../shared/components/ui/button';
import { Card, CardContent } from '../../../../shared/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../../../../shared/components/ui/empty';
import { FieldGroup } from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '../../../../shared/components/ui/item';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../../../shared/ui/Dialog';
import { fmtDateOnly } from '../../../../shared/utils/fmtDateOnly';
import { showToast } from '../../utils/toast';
import { SettingRow, SettingsSectionHeader } from './settingsParts';

// --- Settings › Companion devices (companion-devices task 7.1, design D6; web-ui-system
// "Settings manages the user's Companion devices") ---
//
// The signed-in user's own Companion devices: list, add, revoke. Every action applies at once, so
// there is no save bar and no unsaved state. A new device's token lives only in this component's
// state while its dialog is open: the create mutation invalidates the list rather than caching the
// response, and is reset once its token is taken, so closing the dialog drops the token.

const NAME_MAX = 80;

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function CompanionDevicesSection() {
  const list = useCompanionDevices();
  const create = useCreateCompanionDevice();
  const revoke = useRevokeCompanionDevice();
  const { confirm, confirmElement } = useConfirm();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const created = await create.mutateAsync({ name: trimmed });
      create.reset();
      setToken(created.token);
      setName('');
    } catch (err) {
      setError(errorText(err, 'Could not add the device.'));
    }
  }

  async function handleRevoke(device: CompanionDevice) {
    const ok = await confirm({
      title: 'Revoke device',
      message: `Revoke ${device.name}? Its token stops working at once, and the Stream Deck using it needs a new one.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await revoke.mutateAsync(device.id);
    } catch (err) {
      setError(errorText(err, 'Could not revoke the device.'));
    }
  }

  const devices = list.data?.devices ?? [];

  return (
    <>
      <SettingsSectionHeader
        title="Companion devices"
        description="Tokens that let a Stream Deck running the AutoLogger Companion module act as you."
      />
      <Card>
        <CardContent>
          <form onSubmit={(e) => void handleAdd(e)}>
            <FieldGroup className="gap-4">
              <SettingRow
                label="Device name"
                htmlFor="settings-companion-device-name"
                description="Name the Stream Deck, so you can tell its token apart later."
              >
                <Input
                  id="settings-companion-device-name"
                  type="text"
                  maxLength={NAME_MAX}
                  placeholder="Booth A"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button type="submit" disabled={!name.trim() || create.isPending}>
                  {create.isPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
                  Add device
                </Button>
              </SettingRow>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent>
          {list.isError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>
                {errorText(list.error, 'Could not load your devices.')}
              </AlertDescription>
            </Alert>
          ) : list.isPending ? (
            <Empty aria-busy="true">
              <EmptyHeader>
                <EmptyMedia>
                  <Spinner aria-hidden="true" />
                </EmptyMedia>
                <EmptyDescription>Loading your devices…</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : devices.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <KeyRoundIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No devices yet</EmptyTitle>
                <EmptyDescription>
                  Add one to get a token for the Companion module.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup role="list" aria-label="Your Companion devices">
              {devices.map((device, i) => (
                <Fragment key={device.id}>
                  {i > 0 && <ItemSeparator />}
                  <DeviceRow
                    device={device}
                    revoking={revoke.isPending && revoke.variables === device.id}
                    onRevoke={() => void handleRevoke(device)}
                  />
                </Fragment>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      <TokenDialog token={token} onClose={() => setToken(null)} />
      {confirmElement}
    </>
  );
}

function DeviceRow({
  device,
  revoking,
  onRevoke,
}: {
  device: CompanionDevice;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const lastUsed = device.last_used_at ? fmtDateOnly(device.last_used_at) : 'Never';
  return (
    <Item
      role="listitem"
      size="sm"
      data-testid={`companion-device-${device.id}`}
      className="flex-nowrap"
    >
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{device.name}</span>
          {device.expired && <Badge variant="outline">Expired</Badge>}
        </ItemTitle>
        <ItemDescription className="truncate">
          {`Created ${fmtDateOnly(device.created_at)} · Last used ${lastUsed}`}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <Button
          variant="ghost"
          size="sm"
          disabled={revoking}
          aria-label={`Revoke ${device.name}`}
          onClick={onRevoke}
        >
          {revoking && <Spinner data-icon="inline-start" aria-hidden="true" />}
          Revoke
        </Button>
      </ItemActions>
    </Item>
  );
}

/** The new device's token, shown once. Closing it (Done, Escape, outside click) drops the token. */
function TokenDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      showToast('Token copied.');
    } catch {
      showToast('Copy failed. Select the token and copy it instead.');
    }
  }

  return (
    <Dialog
      open={token !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Device token"
      description="Paste it into the Companion module's Device token field."
      closeOnOverlayClick={false}
    >
      {token !== null && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              aria-label="Device token"
              value={token}
              className="font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" onClick={() => void copy()}>
              <CopyIcon data-icon="inline-start" aria-hidden="true" />
              Copy
            </Button>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            Copy this token now. It won't be shown again.
          </p>
          <DialogActions>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </DialogActions>
        </div>
      )}
    </Dialog>
  );
}
