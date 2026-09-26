import type { PropertyDefinition } from '@tessera/core';
import { Badge } from '@tessera/ui';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { formatDay } from '../query/format';
import { isoWeekStart } from '../query/dates';
import type { RowGroup } from '../query/group';
import type { QueryContext } from '../query/types';
import { OptionBadge, displayTitle } from './common';

/** A group's name as text (accessible names, announcements). */
export function groupName(
  group: Pick<RowGroup, 'key' | 'isEmpty' | 'option'>,
  property: PropertyDefinition,
  queryCtx: QueryContext,
): string {
  if (group.isEmpty) return t('noValue', { property: property.name || t('untitled') });
  if (group.option) return group.option.name;
  switch (property.type) {
    case 'checkbox':
      return group.key === 'true' ? t('checked') : t('unchecked');
    case 'date':
    case 'createdTime':
    case 'updatedTime': {
      const key = group.key;
      if (/^\d{4}-\d{2}-\d{2}$/.test(key))
        return formatDay(key, { format: 'medium', timeFormat: 'locale' }, queryCtx);
      const week = isoWeekStart(key);
      if (week)
        return t('weekOf', {
          date: formatDay(week, { format: 'medium', timeFormat: 'locale' }, queryCtx),
        });
      if (/^\d{4}-\d{2}$/.test(key))
        return new Intl.DateTimeFormat(queryCtx.locale, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(Date.parse(`${key}-01T00:00:00Z`));
      return key;
    }
    case 'relation':
      return group.key
        .split(',')
        .map((id) => displayTitle(queryCtx.titleOf?.(id)))
        .join(', ');
    default:
      return group.key;
  }
}

/** A group's name as it shows in headers: option tags keep their color. */
export function GroupLabel({
  group,
  property,
  queryCtx,
}: {
  group: Pick<RowGroup, 'key' | 'isEmpty' | 'option'>;
  property: PropertyDefinition;
  queryCtx: QueryContext;
}): ReactNode {
  if (group.option) return <OptionBadge option={group.option} />;
  const name = groupName(group, property, queryCtx);
  if (group.isEmpty) return <span className="text-sm text-fg-muted">{name}</span>;
  if (property.type === 'checkbox')
    return <Badge tone={group.key === 'true' ? 'green' : 'gray'}>{name}</Badge>;
  return <span className="truncate text-sm font-medium text-fg">{name}</span>;
}
