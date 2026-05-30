import React, { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { tokens } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { listen, send } from '@actual-app/core/platform/client/connection';
import { isElectron } from '@actual-app/core/shared/environment';
import type {
  LLMClassificationConfig,
  LLMClassificationProvider,
} from '@actual-app/core/types/prefs';
import { css } from '@emotion/css';

import { getLatestAppVersion } from '#app/appSlice';
import { closeBudget } from '#budgetfiles/budgetfilesSlice';
import { Link } from '#components/common/Link';
import { Checkbox, FormField, FormLabel } from '#components/forms';
import { MOBILE_NAV_HEIGHT } from '#components/mobile/MobileNavTabs';
import { Page } from '#components/Page';
import { useServerVersion } from '#components/ServerContext';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useGlobalPref } from '#hooks/useGlobalPref';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useSyncedPref } from '#hooks/useSyncedPref';
import { loadPrefs } from '#prefs/prefsSlice';
import { useDispatch, useSelector } from '#redux';

import { AuthSettings } from './AuthSettings';
import { Backups } from './Backups';
import { BudgetTypeSettings } from './BudgetTypeSettings';
import { CurrencySettings } from './Currency';
import { EncryptionSettings } from './Encryption';
import { ExperimentalFeatures } from './Experimental';
import { ExportBudget } from './Export';
import { FormatSettings } from './Format';
import { LanguageSettings } from './LanguageSettings';
import { RepairTransactions } from './RepairTransactions';
import { ResetCache, ResetSync } from './Reset';
import { ThemeSettings } from './Themes';
import { AdvancedToggle, Setting } from './UI';

function About() {
  const version = useServerVersion();
  const versionInfo = useSelector(state => state.app.versionInfo);
  const [notifyWhenUpdateIsAvailable, setNotifyWhenUpdateIsAvailablePref] =
    useGlobalPref('notifyWhenUpdateIsAvailable', () => {
      void dispatch(getLatestAppVersion());
    });
  const dispatch = useDispatch();

  return (
    <Setting>
      <Text>
        <Trans>
          <strong>Actual</strong> is a super fast privacy-focused app for
          managing your finances.
        </Trans>
      </Text>
      <View
        style={{
          flexDirection: 'column',
          gap: 10,
        }}
        className={css({
          [`@media (min-width: ${tokens.breakpoint_small})`]: {
            display: 'grid',
            gridTemplateRows: '1fr 1fr',
            gridTemplateColumns: '50% 50%',
            columnGap: '2em',
            gridAutoFlow: 'column',
          },
        })}
        data-vrt-mask
      >
        <Text>
          <Trans>
            Client version: {{ version: `v${window.Actual?.ACTUAL_VERSION}` }}
          </Trans>
        </Text>
        <Text>
          <Trans>Server version: {{ version }}</Trans>
        </Text>

        {notifyWhenUpdateIsAvailable && versionInfo?.isOutdated ? (
          <Link
            variant="external"
            to="https://actualbudget.org/docs/releases"
            linkColor="purple"
          >
            <Trans>New version available: {versionInfo.latestVersion}</Trans>
          </Link>
        ) : (
          <Text style={{ color: theme.noticeText, fontWeight: 600 }}>
            {notifyWhenUpdateIsAvailable ? (
              <Trans>You're up to date!</Trans>
            ) : null}
          </Text>
        )}
        <Text>
          <Link
            variant="external"
            to="https://actualbudget.org/docs/releases"
            linkColor="purple"
          >
            <Trans>Release Notes</Trans>
          </Link>
        </Text>
      </View>
      <View>
        <Text style={{ display: 'flex' }}>
          <Checkbox
            id="settings-notifyWhenUpdateIsAvailable"
            checked={notifyWhenUpdateIsAvailable}
            onChange={e =>
              setNotifyWhenUpdateIsAvailablePref(e.currentTarget.checked)
            }
          />
          <label htmlFor="settings-notifyWhenUpdateIsAvailable">
            <Trans>Display a notification when updates are available</Trans>
          </label>
        </Text>
      </View>
    </Setting>
  );
}

function IDName({ children }: { children: ReactNode }) {
  return <Text style={{ fontWeight: 500 }}>{children}</Text>;
}

function AdvancedAbout() {
  const [budgetId] = useMetadataPref('id');
  const [groupId] = useMetadataPref('groupId');
  const { t } = useTranslation();

  return (
    <Setting>
      <Text>
        <Trans>
          <strong>IDs</strong> are the names Actual uses to identify your budget
          internally. There are several different IDs associated with your
          budget. The Budget ID is used to identify your budget file. The Sync
          ID is used to access the budget on the server.
        </Trans>
      </Text>
      <Text>
        <Trans>
          <IDName>Budget ID:</IDName> {{ budgetId }}
        </Trans>
      </Text>
      <Text style={{ color: theme.pageText }}>
        <Trans>
          <IDName>Sync ID:</IDName> {{ syncId: groupId || t('(none)') }}
        </Trans>
      </Text>
      {/* low priority todo: eliminate some or all of these, or decide when/if to show them */}
      {/* <Text>
        <IDName>Cloud File ID:</IDName> {prefs.cloudFileId || t('(none)')}
      </Text>
      <Text>
        <IDName>User ID:</IDName> {prefs.userId || t('(none)')}
      </Text> */}
    </Setting>
  );
}

const llmProviderOptions: Array<[LLMClassificationProvider, string]> = [
  ['ollama', 'Ollama'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['google', 'Google Gemini'],
];

const llmProviderDefaults = {
  ollama: {
    endpoint: 'http://127.0.0.1:11434/api/chat',
  },
  openai: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
  anthropic: {
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
  google: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  },
  googleVertex: {
    endpoint: 'https://aiplatform.googleapis.com/v1',
  },
  amazonBedrock: {
    endpoint: 'https://bedrock-runtime.{region}.amazonaws.com',
  },
} satisfies Record<
  LLMClassificationProvider,
  Pick<LLMClassificationConfig, 'endpoint'>
>;

const defaultLLMConfig = {
  provider: 'ollama',
  ...llmProviderDefaults.ollama,
  model: '',
  timeoutMs: 180000,
  batchSize: 12,
} satisfies LLMClassificationConfig;

function getErrorMessage(err: unknown): string {
  if (typeof err === 'string') {
    return err;
  }

  if (err && typeof err === 'object') {
    if ('message' in err && typeof err.message === 'string') {
      return err.message;
    }
    if ('details' in err && typeof err.details === 'string') {
      return err.details;
    }
  }

  return 'Unknown error';
}

function getModelFromFetchedModels(
  currentModel: string | undefined,
  models: string[],
): string {
  if (models.length === 0) {
    return '';
  }

  return currentModel && models.includes(currentModel)
    ? currentModel
    : models[0];
}

function LLMClassificationSettings() {
  const { t } = useTranslation();
  const [savedConfig, setSavedConfig] = useGlobalPref(
    'llmClassificationConfig',
  );
  const [config, setConfig] =
    useState<LLMClassificationConfig>(defaultLLMConfig);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [debouncedApiKey, setDebouncedApiKey] = useState(config.apiKey || '');

  const updateConfig = <Key extends keyof LLMClassificationConfig>(
    key: Key,
    value: LLMClassificationConfig[Key],
  ) => {
    setConfig(current => {
      const updated = { ...current, [key]: value };
      if (key === 'apiKey' && typeof value === 'string') {
        const provider = current.provider || 'ollama';
        const apiKeys = {
          ...(current.apiKeys || {}),
          [provider]: value,
        };
        updated.apiKeys = apiKeys;
      }
      return updated;
    });
  };

  useEffect(() => {
    if (savedConfig) {
      const provider = savedConfig.provider || 'ollama';
      const existingApiKey =
        savedConfig.apiKey || savedConfig.apiKeys?.[provider] || '';
      const apiKeys = {
        ...(savedConfig.apiKeys || {}),
        [provider]: existingApiKey,
      };
      setConfig({
        ...defaultLLMConfig,
        ...savedConfig,
        apiKey: existingApiKey,
        apiKeys,
      });
    } else {
      setConfig(defaultLLMConfig);
    }
  }, [savedConfig]);

  // Debounce API key typing by 800ms
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedApiKey(config.apiKey || '');
    }, 800);

    return () => {
      clearTimeout(handler);
    };
  }, [config.apiKey]);

  useEffect(() => {
    let active = true;
    const provider = config.provider || 'ollama';
    const isFetchable = ['ollama', 'openai', 'anthropic', 'google'].includes(
      provider,
    );
    const hasKey = provider === 'ollama' || !!debouncedApiKey;

    if (!isFetchable || !hasKey) {
      setFetchedModels([]);
      setIsLoadingModels(false);
      setFetchError(null);
      setConfig(current => ({ ...current, model: '' }));
      return;
    }

    async function fetchModels() {
      setIsLoadingModels(true);
      setFetchError(null);
      try {
        const models = await send('llm-fetch-models', {
          provider,
          apiKey: debouncedApiKey,
          endpoint: config.endpoint,
        });
        if (active) {
          setFetchedModels(models);
          setConfig(current => ({
            ...current,
            model: getModelFromFetchedModels(current.model, models),
          }));
        }
      } catch (err) {
        if (active) {
          setFetchedModels([]);
          setConfig(current => ({ ...current, model: '' }));
          setFetchError(getErrorMessage(err));
        }
      } finally {
        if (active) {
          setIsLoadingModels(false);
        }
      }
    }

    void fetchModels();

    return () => {
      active = false;
    };
  }, [config.provider, debouncedApiKey, config.endpoint]);

  const saveConfig = () => {
    setSavedConfig({
      ...config,
      timeoutMs: Number(config.timeoutMs) || defaultLLMConfig.timeoutMs,
      batchSize: Number(config.batchSize) || defaultLLMConfig.batchSize,
    });
  };

  const provider = config.provider || 'ollama';
  const fetchableProviders: LLMClassificationProvider[] = [
    'ollama',
    'openai',
    'anthropic',
    'google',
  ];
  const isFetchableProvider = fetchableProviders.includes(provider);
  const requiresApiKey = provider !== 'ollama';
  const hasKey = provider === 'ollama' || !!config.apiKey;
  const isMissingKey = isFetchableProvider && requiresApiKey && !config.apiKey;
  const hasNoModels =
    isFetchableProvider &&
    hasKey &&
    !isLoadingModels &&
    !fetchError &&
    fetchedModels.length === 0;
  const modelOptions = fetchedModels.map(m => [m, m] as [string, string]);
  const isModelRequired = isFetchableProvider;
  const isSaveDisabled = isModelRequired && !config.model;
  const modelPlaceholder = isMissingKey
    ? t('Enter an API key to load models')
    : isLoadingModels
      ? t('Loading models...')
      : fetchError
        ? t('Unable to load models')
        : hasNoModels
          ? t('No models returned')
          : t('Select a model');

  const updateProvider = (value: LLMClassificationProvider) => {
    setConfig(current => {
      const apiKeys = current.apiKeys || {};
      const newApiKey = apiKeys[value] || '';
      setDebouncedApiKey(newApiKey);
      setFetchedModels([]);
      setFetchError(null);
      setIsLoadingModels(false);
      return {
        ...current,
        ...llmProviderDefaults[value],
        provider: value,
        apiKey: newApiKey,
        model: '',
      };
    });
  };

  return (
    <Setting>
      <Text>
        <Trans>
          <strong>LLM transaction categorization</strong> configures the local
          model provider used by bank sync account settings. Transactions are
          only sent when the option is enabled for an individual bank account.
        </Trans>
      </Text>
      <View style={{ gap: 10, width: '100%' }}>
        <FormField>
          <FormLabel title={t('Provider')} htmlFor="settings-llmProvider" />
          <Select
            id="settings-llmProvider"
            options={llmProviderOptions}
            value={provider}
            onChange={updateProvider}
            style={{ width: '100%' }}
          />
        </FormField>
        {requiresApiKey && (
          <FormField>
            <FormLabel title={t('API key')} htmlFor="settings-llmApiKey" />
            <Input
              id="settings-llmApiKey"
              type="password"
              value={config.apiKey || ''}
              onChangeValue={value => updateConfig('apiKey', value)}
              placeholder={t('Required for this provider')}
              style={{ width: '100%' }}
            />
          </FormField>
        )}
        <FormField>
          <FormLabel
            title={
              t('Model') + (isLoadingModels ? ` (${t('loading...')})` : '')
            }
            htmlFor="settings-llmModel"
          />
          {isFetchableProvider ? (
            <Select
              id="settings-llmModel"
              options={modelOptions}
              value={config.model || ''}
              onChange={value => updateConfig('model', value)}
              disabled={isModelRequired && modelOptions.length === 0}
              defaultLabel={modelPlaceholder}
              style={{ width: '100%' }}
            />
          ) : (
            <Input
              id="settings-llmModel"
              value={config.model || ''}
              onChangeValue={value => updateConfig('model', value)}
              placeholder={t('Model name')}
              style={{ width: '100%' }}
            />
          )}
        </FormField>
        {fetchError && (
          <Text
            style={{
              color: theme.warningText,
              backgroundColor: theme.warningBackground,
              border: `1px solid ${theme.warningBorder}`,
              borderRadius: 4,
              padding: '10px 12px',
              fontSize: 13,
              lineHeight: '1.4em',
              marginTop: -5,
              marginBottom: 5,
            }}
          >
            <Trans>
              <strong>Error Loading Models:</strong> {fetchError}. Please verify
              your API key and connection. (Note: Running in a browser without a
              sync server restricts direct cloud LLM requests due to CORS
              security. Run the desktop app or connect to a sync server.)
            </Trans>
          </Text>
        )}
        <FormField>
          <FormLabel
            title={t('Endpoint or base URL')}
            htmlFor="settings-llmEndpoint"
          />
          <Input
            id="settings-llmEndpoint"
            value={config.endpoint || ''}
            onChangeValue={value => updateConfig('endpoint', value)}
            placeholder={t('Provider default')}
            style={{ width: '100%' }}
          />
        </FormField>
        {provider === 'googleVertex' && (
          <>
            <FormField>
              <FormLabel
                title={t('Vertex project ID')}
                htmlFor="settings-llmVertexProject"
              />
              <Input
                id="settings-llmVertexProject"
                value={config.vertexProjectId || ''}
                onChangeValue={value => updateConfig('vertexProjectId', value)}
                style={{ width: '100%' }}
              />
            </FormField>
            <FormField>
              <FormLabel
                title={t('Vertex location')}
                htmlFor="settings-llmVertexLocation"
              />
              <Input
                id="settings-llmVertexLocation"
                value={config.vertexLocation || ''}
                onChangeValue={value => updateConfig('vertexLocation', value)}
                placeholder="us-central1"
                style={{ width: '100%' }}
              />
            </FormField>
          </>
        )}
        {provider === 'amazonBedrock' && (
          <FormField>
            <FormLabel
              title={t('Bedrock region')}
              htmlFor="settings-llmBedrockRegion"
            />
            <Input
              id="settings-llmBedrockRegion"
              value={config.bedrockRegion || ''}
              onChangeValue={value => updateConfig('bedrockRegion', value)}
              placeholder="us-east-1"
              style={{ width: '100%' }}
            />
          </FormField>
        )}
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
          }}
        >
          <FormField style={{ flex: 1 }}>
            <FormLabel
              title={t('Timeout (seconds)')}
              htmlFor="settings-llmTimeout"
            />
            <Input
              id="settings-llmTimeout"
              type="number"
              min={1}
              value={String(
                Math.round(
                  (config.timeoutMs || defaultLLMConfig.timeoutMs) / 1000,
                ),
              )}
              onChangeValue={value =>
                updateConfig('timeoutMs', Number(value) * 1000)
              }
              style={{ width: '100%' }}
            />
          </FormField>
          <FormField style={{ flex: 1 }}>
            <FormLabel title={t('Batch size')} htmlFor="settings-llmBatch" />
            <Input
              id="settings-llmBatch"
              type="number"
              min={1}
              max={50}
              value={String(config.batchSize || defaultLLMConfig.batchSize)}
              onChangeValue={value => updateConfig('batchSize', Number(value))}
              style={{ width: '100%' }}
            />
          </FormField>
        </View>
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>
            API keys are stored on this device and are not synced with the
            budget file.
          </Trans>
        </Text>
        <Button
          variant="primary"
          onPress={saveConfig}
          isDisabled={isSaveDisabled}
        >
          <Trans>Save LLM settings</Trans>
        </Button>
      </View>
    </Setting>
  );
}

export function Settings() {
  const { t } = useTranslation();
  const [floatingSidebar] = useGlobalPref('floatingSidebar');
  const [budgetName] = useMetadataPref('budgetName');
  const dispatch = useDispatch();
  const isCurrencyExperimentalEnabled = useFeatureFlag('currency');
  const [_, setDefaultCurrencyCodePref] = useSyncedPref('defaultCurrencyCode');

  const onCloseBudget = () => {
    void dispatch(closeBudget());
  };

  useEffect(() => {
    const unlisten = listen('prefs-updated', () => {
      void dispatch(loadPrefs());
    });

    void dispatch(loadPrefs());
    return () => unlisten();
  }, [dispatch]);

  useEffect(() => {
    if (!isCurrencyExperimentalEnabled) {
      setDefaultCurrencyCodePref('');
    }
  }, [isCurrencyExperimentalEnabled, setDefaultCurrencyCodePref]);

  const { isNarrowWidth } = useResponsive();

  return (
    <Page
      header={t('Settings')}
      style={{
        marginInline: floatingSidebar && !isNarrowWidth ? 'auto' : 0,
      }}
    >
      <View
        data-testid="settings"
        style={{
          marginTop: 10,
          flexShrink: 0,
          maxWidth: 530,
          width: '100%',
          gap: 30,
          paddingBottom: MOBILE_NAV_HEIGHT,
        }}
      >
        {isNarrowWidth && (
          <View
            style={{
              gap: 10,
              flexDirection: 'row',
              alignItems: 'flex-end',
              width: '100%',
            }}
          >
            {/* The only spot to close a budget on mobile */}
            <FormField style={{ flex: 1 }}>
              <FormLabel title={t('Budget name')} />
              <Input
                value={budgetName}
                disabled
                style={{ color: theme.buttonNormalDisabledText }}
              />
            </FormField>
            <Button onPress={onCloseBudget} style={{ flexShrink: 0 }}>
              <Trans>Switch file</Trans>
            </Button>
          </View>
        )}
        <About />
        <ThemeSettings />
        <FormatSettings />
        {isCurrencyExperimentalEnabled && <CurrencySettings />}
        <LanguageSettings />
        <AuthSettings />
        <EncryptionSettings />
        <BudgetTypeSettings />
        <LLMClassificationSettings />
        {isElectron() && <Backups />}
        <ExportBudget />
        <AdvancedToggle>
          <AdvancedAbout />
          <ResetCache />
          <ResetSync />
          <RepairTransactions />
          <ExperimentalFeatures />
        </AdvancedToggle>
      </View>
    </Page>
  );
}
