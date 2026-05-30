import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { tokens } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import type { CategoryEntity } from '@actual-app/core/types/models';
import { css } from '@emotion/css';

import { Page } from '#components/Page';
import { useCategories } from '#hooks/useCategories';
import { useSyncedPref } from '#hooks/useSyncedPref';

type ClassificationHints = Record<string, string>;

function parseHints(raw: string | undefined): ClassificationHints {
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
        .map(([categoryId, hints]) => [categoryId, hints]),
    );
  } catch {
    return {};
  }
}

function serializeHints(hints: ClassificationHints): string {
  const nonEmptyHints = Object.fromEntries(
    Object.entries(hints)
      .map(([categoryId, value]) => [categoryId, value.trim()])
      .filter(([, value]) => value !== ''),
  );

  return JSON.stringify(nonEmptyHints);
}

function HintRow({
  category,
  value,
  onChange,
  onSave,
}: {
  category: CategoryEntity;
  value: string;
  onChange: (categoryId: string, value: string) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();

  return (
    <View
      className={css({
        display: 'grid',
        gridTemplateColumns: 'minmax(180px, 260px) minmax(280px, 1fr)',
        borderTop: `1px solid ${theme.tableBorder}`,
        backgroundColor: theme.tableBackground,
        [`@media (max-width: ${tokens.breakpoint_small})`]: {
          gridTemplateColumns: '1fr',
        },
      })}
    >
      <View
        style={{
          padding: '13px 16px',
          justifyContent: 'center',
          borderRight: `1px solid ${theme.tableBorder}`,
        }}
        className={css({
          [`@media (max-width: ${tokens.breakpoint_small})`]: {
            borderRight: 0,
            paddingBottom: 4,
          },
        })}
      >
        <Text style={{ fontWeight: 500 }}>{category.name}</Text>
      </View>
      <View style={{ padding: '8px 12px' }}>
        <textarea
          aria-label={t('Hints for {{categoryName}}', {
            categoryName: category.name,
          })}
          value={value}
          onChange={event => onChange(category.id, event.currentTarget.value)}
          onBlur={onSave}
          placeholder={t('Add hints for this category')}
          rows={2}
          className={css({
            width: '100%',
            minHeight: 44,
            resize: 'vertical',
            border: `1px solid ${theme.formInputBorder}`,
            borderRadius: 4,
            backgroundColor: theme.formInputBackground,
            color: theme.formInputText,
            padding: '8px 10px',
            font: 'inherit',
            lineHeight: 1.35,
            ':focus': {
              outline: 'none',
              borderColor: theme.formInputBorderSelected,
              boxShadow: theme.formInputShadowSelected,
            },
            '::placeholder': {
              color: theme.formInputTextPlaceholder,
            },
          })}
        />
      </View>
    </View>
  );
}

export function ClassificationHintsPage() {
  const { t } = useTranslation();
  const { data: { list: categories } = { list: [] } } = useCategories();
  const [savedHints = '{}', setSavedHints] = useSyncedPref(
    'llmClassificationHints',
  );
  const [draftHints, setDraftHints] = useState<ClassificationHints>(() =>
    parseHints(savedHints),
  );

  useEffect(() => {
    setDraftHints(parseHints(savedHints));
  }, [savedHints]);

  const updateHint = (categoryId: string, value: string) => {
    setDraftHints(current => ({
      ...current,
      [categoryId]: value,
    }));
  };

  const saveHints = () => {
    setSavedHints(serializeHints(draftHints));
  };

  return (
    <Page header={t('Classification hints')}>
      <View style={{ gap: 15, flexShrink: 0, width: '100%' }}>
        <Text
          style={{
            color: theme.pageTextLight,
            maxWidth: 760,
            lineHeight: 1.4,
          }}
        >
          <Trans>
            Hints describe how you use each budget category. They are included
            with allowed categories when LLM transaction categorization runs.
          </Trans>
        </Text>
        <View
          style={styles.tableContainer}
          className={css({
            maxWidth: 920,
            width: '100%',
            flex: '0 1 auto',
          })}
        >
          <View
            className={css({
              display: 'grid',
              gridTemplateColumns: 'minmax(180px, 260px) minmax(280px, 1fr)',
              backgroundColor: theme.tableHeaderBackground,
              color: theme.tableHeaderText,
              fontWeight: 600,
              [`@media (max-width: ${tokens.breakpoint_small})`]: {
                display: 'none',
              },
            })}
          >
            <View
              style={{
                padding: '10px 16px',
                borderRight: `1px solid ${theme.tableBorder}`,
              }}
            >
              <Trans>Budget category</Trans>
            </View>
            <View style={{ padding: '10px 12px' }}>
              <Trans>Hints</Trans>
            </View>
          </View>
          {categories.map(category => (
            <HintRow
              key={category.id}
              category={category}
              value={draftHints[category.id] || ''}
              onChange={updateHint}
              onSave={saveHints}
            />
          ))}
        </View>
      </View>
    </Page>
  );
}
