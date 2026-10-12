-- Keyless `claude-cli` provider rows (OpenSpec change `ai-sdk-agent-harness`, design D2).
--
-- - A user on `CLAUDE_CLI_EMAILS` may save the `llm` provider `claude-cli`: the operator's Claude
--   CLI login, with no API key, no base URL and the fixed model `claude-cli`. Its row stores no key,
--   so `not null` is dropped from `key_nonce`, `key_ciphertext`, `key_tag`, `key_version` and
--   `key_last4`.
-- - `user_provider_credentials_claude_cli_check` replaces that guarantee:
--   - a `claude-cli` row is of kind `llm`, has a null `base_url` (so a null `base_origin`, by
--     `user_provider_credentials_origin_check`) and all five key columns null;
--   - every other row has **each** of the five key columns non-null, so a keyed row can never be
--     partly null.
-- - `model` stays non-null; the server stores `claude-cli` for this row.
-- - Every existing row has a key and a provider other than `claude-cli`, so it already satisfies the
--   check and is unchanged. Access rules are unchanged.
-- - Rollback (a documented step, not a migration file), after reverting the code. The old code
--   expects a key on every row, so delete the keyless rows first:
--   `delete from catalog.user_provider_credentials where provider = 'claude-cli';`
--   `alter table catalog.user_provider_credentials
--      drop constraint user_provider_credentials_claude_cli_check,
--      alter column key_nonce set not null, alter column key_ciphertext set not null,
--      alter column key_tag set not null, alter column key_version set not null,
--      alter column key_last4 set not null;`

alter table catalog.user_provider_credentials
  alter column key_nonce drop not null,
  alter column key_ciphertext drop not null,
  alter column key_tag drop not null,
  alter column key_version drop not null,
  alter column key_last4 drop not null,
  add constraint user_provider_credentials_claude_cli_check check (
    (provider = 'claude-cli'
      and kind = 'llm'
      and base_url is null
      and key_nonce is null
      and key_ciphertext is null
      and key_tag is null
      and key_version is null
      and key_last4 is null)
    or
    (provider <> 'claude-cli'
      and key_nonce is not null
      and key_ciphertext is not null
      and key_tag is not null
      and key_version is not null
      and key_last4 is not null)
  );
