import { PlugIcon, TriangleAlertIcon } from 'lucide-react';
import { Fragment, useState } from 'react';
import {
  isFeatureOff,
  useConnectedApps,
  useRevokeConnectedApp,
} from '../../../../api/hooks/useConnectedApps';
import type { ConnectedApp } from '../../../../api/types';
import { Alert, AlertDescription } from '../../../../shared/components/ui/alert';
import { Button } from '../../../../shared/components/ui/button';
import { Card, CardContent } from '../../../../shared/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../../../../shared/components/ui/empty';
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
import { fmtDateOnly } from '../../../../shared/utils/fmtDateOnly';
import { SettingsSectionHeader } from './settingsParts';

// --- Settings › Connected apps (custom session dashboards J4, design 4.8; web-ui-system
// "Settings manages the user's connected apps") ---
//
// The Claude connections (OAuth grants) the signed-in user approved: list and revoke. Every action
// applies at once, so there is no save bar. The list route exists only with
// `CUSTOM_DASHBOARDS_ENABLED` on; a `404` means "feature off", and then the section renders nothing
// (the Settings view also leaves it out of the navigation). Client names are client-supplied, so
// they are rendered as React text children only, never as markup.

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function ConnectedAppsSection() {
  const list = useConnectedApps();
  const revoke = useRevokeConnectedApp();
  const { confirm, confirmElement } = useConfirm();
  const [error, setError] = useState<string | null>(null);

  if (list.isError && isFeatureOff(list.error)) return null;

  async function handleRevoke(app: ConnectedApp) {
    const ok = await confirm({
      title: 'Revoke connected app',
      message: `Revoke ${app.client_name}? It loses access at once, and has to be connected again to use your sessions.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await revoke.mutateAsync(app.grant_id);
    } catch (err) {
      setError(errorText(err, 'Could not revoke the app.'));
    }
  }

  const apps = list.data?.apps ?? [];

  return (
    <>
      <SettingsSectionHeader
        title="Connected apps"
        description="Claude connections you approved. Revoking one ends its access to your sessions."
      />
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
                {errorText(list.error, 'Could not load your connected apps.')}
              </AlertDescription>
            </Alert>
          ) : list.isPending ? (
            <Empty aria-busy="true">
              <EmptyHeader>
                <EmptyMedia>
                  <Spinner aria-hidden="true" />
                </EmptyMedia>
                <EmptyDescription>Loading your connected apps…</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : apps.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PlugIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No connected apps</EmptyTitle>
                <EmptyDescription>
                  Connect AutoLogger from Claude and it will be listed here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup role="list" aria-label="Your connected apps">
              {apps.map((app, i) => (
                <Fragment key={app.grant_id}>
                  {i > 0 && <ItemSeparator />}
                  <AppRow
                    app={app}
                    revoking={revoke.isPending && revoke.variables === app.grant_id}
                    onRevoke={() => void handleRevoke(app)}
                  />
                </Fragment>
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>
      {confirmElement}
    </>
  );
}

function AppRow({
  app,
  revoking,
  onRevoke,
}: {
  app: ConnectedApp;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const lastUsed = app.last_used_at ? fmtDateOnly(app.last_used_at) : 'Never';
  return (
    <Item
      role="listitem"
      size="sm"
      data-testid={`connected-app-${app.grant_id}`}
      className="flex-nowrap"
    >
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{app.client_name}</span>
        </ItemTitle>
        <ItemDescription className="truncate">
          {`${app.redirect_host} · Connected ${fmtDateOnly(app.created_at)} · Last used ${lastUsed}`}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <Button
          variant="ghost"
          size="sm"
          disabled={revoking}
          aria-label={`Revoke ${app.client_name}`}
          onClick={onRevoke}
        >
          {revoking && <Spinner data-icon="inline-start" aria-hidden="true" />}
          Revoke
        </Button>
      </ItemActions>
    </Item>
  );
}
