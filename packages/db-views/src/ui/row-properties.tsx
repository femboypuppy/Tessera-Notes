import type { PropertyDefinition, PropertyType, ResolvedRow } from '@tessera/core';
import { useAppContext, usePage, usePagesSelector } from '@tessera/core/react';
import {
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Skeleton,
  cn,
} from '@tessera/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { t } from '../i18n';
import {
  addDatabaseProperty,
  renameProperty,
  setCell,
  type DatabaseRef,
} from '../model/operations';
import type { DatabaseSnapshot } from '../model/store';
import { readCell } from '../query/cells';
import { withFormulaValues } from '../query/formula/rows';
import type { QueryContext } from '../query/types';
import { CellDisplay } from './cells/display';
import {
  DateCellEditor,
  OptionsCellEditor,
  POPOVER_EDITOR_TYPES,
  RelationCellEditor,
  TEXT_EDITOR_TYPES,
  TextCellEditor,
  type CellEditorProps,
} from './cells/editors';
import { PICKABLE_TYPES, PropertyIcon, displayTitle, typeLabel } from './common';
import { runAction, useAfterMenuClose, useDatabase, useQueryContext } from './hooks';
import { FormulaDialog } from './formula-dialog';
import { OptionsDialog } from './options-dialog';
import { PropertyMenuItems } from './property-menu';
import { RenameInput } from './table/header-cell';

function PopoverEditor(props: CellEditorProps) {
  switch (props.property.type) {
    case 'select':
    case 'multiSelect':
      return <OptionsCellEditor {...props} />;
    case 'date':
      return <DateCellEditor {...props} />;
    default:
      return <RelationCellEditor {...props} />;
  }
}

function PropertyRow({
  database,
  snapshot,
  row,
  property,
  queryCtx,
  readOnly,
  renaming,
  setRenaming,
}: {
  database: DatabaseRef;
  snapshot: DatabaseSnapshot;
  row: ResolvedRow;
  property: PropertyDefinition;
  queryCtx: QueryContext;
  readOnly: boolean;
  renaming: boolean;
  setRenaming: (renaming: boolean) => void;
}) {
  const ctx = useAppContext();
  const [editing, setEditing] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const afterMenu = useAfterMenuClose();
  const value = readCell(row, property);
  const empty =
    value === null ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && value.length === 0);
  const computed =
    property.type === 'createdTime' ||
    property.type === 'updatedTime' ||
    property.type === 'formula';
  const editable = !readOnly && !computed;
  const name = property.name || t('untitled');
  const editorProps: CellEditorProps = {
    database,
    row,
    property,
    queryCtx,
    onDone: () => setEditing(false),
  };
  const display = (
    <span className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1 py-1">
      {empty && property.type !== 'checkbox' ? (
        <span className="text-sm text-fg-subtle">{t('empty')}</span>
      ) : (
        <CellDisplay row={row} property={property} queryCtx={queryCtx} wrap />
      )}
    </span>
  );
  return (
    <div className="group/prop flex min-w-0 items-start gap-2" data-property-id={property.id}>
      <div className="w-40 shrink-0 max-sm:w-28">
        {renaming ? (
          <RenameInput
            initial={property.name}
            label={t('propertyName')}
            className="mx-0"
            onDone={(next) => {
              if (next !== null && next.trim() !== property.name)
                runAction(ctx, () => renameProperty(database, property.id, next));
              setRenaming(false);
            }}
          />
        ) : (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild disabled={readOnly}>
              <button
                type="button"
                className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-ui text-fg-muted hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                <PropertyIcon type={property.type} />
                <span className="truncate">{name}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-60"
              onCloseAutoFocus={afterMenu.onCloseAutoFocus}
            >
              <PropertyMenuItems
                database={database}
                property={property}
                rows={snapshot.rows}
                queryCtx={queryCtx}
                actions={{
                  rename: () => afterMenu.schedule(() => setRenaming(true)),
                  editOptions: () => setOptionsOpen(true),
                  editFormula: () => afterMenu.schedule(() => setFormulaOpen(true)),
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="relative min-w-0 flex-1">
        {editing && TEXT_EDITOR_TYPES.has(property.type) ? (
          <div className="rounded-md ring-2 ring-accent">
            <TextCellEditor {...editorProps} className="rounded-md" />
          </div>
        ) : property.type === 'checkbox' ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={value === true}
            aria-label={name}
            disabled={!editable}
            onClick={() =>
              runAction(ctx, () =>
                setCell(ctx, database, row.id, property, value === true ? null : true),
              )
            }
            className="flex h-8 items-center rounded-md px-1.5 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          >
            <CellDisplay row={row} property={property} queryCtx={queryCtx} />
          </button>
        ) : (
          <Popover
            open={editing && POPOVER_EDITOR_TYPES.has(property.type)}
            onOpenChange={(open) => setEditing(open)}
          >
            <PopoverAnchor asChild>
              <button
                type="button"
                aria-label={`${name}: ${empty ? t('empty') : ''}`.replace(/: $/, '')}
                aria-readonly={!editable || undefined}
                disabled={readOnly}
                onClick={() => {
                  if (editable) setEditing(true);
                  else if (property.type === 'formula' && !readOnly) setFormulaOpen(true);
                }}
                className={cn(
                  'flex w-full min-w-0 items-start rounded-md px-1.5 text-left hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none',
                  !editable &&
                    (property.type !== 'formula' || readOnly) &&
                    'cursor-default hover:bg-transparent',
                )}
              >
                {display}
              </button>
            </PopoverAnchor>
            <PopoverContent
              align="start"
              className="p-2"
              onKeyDown={(event) => event.stopPropagation()}
            >
              <PopoverEditor {...editorProps} />
            </PopoverContent>
          </Popover>
        )}
      </div>
      {optionsOpen ? (
        <OptionsDialog open onOpenChange={setOptionsOpen} database={database} property={property} />
      ) : null}
      {formulaOpen ? (
        <FormulaDialog
          open
          onOpenChange={setFormulaOpen}
          database={database}
          property={property}
          properties={snapshot.properties}
          rows={[row, ...snapshot.rows.filter((candidate) => candidate.id !== row.id)]}
          queryCtx={queryCtx}
        />
      ) : null}
    </div>
  );
}

/** The properties of a database row, under its title (row pages and the side peek). */
export function RowPropertiesPanel({ pageId, readOnly }: { pageId: string; readOnly: boolean }) {
  const ctx = useAppContext();
  const databaseId = usePagesSelector((pages) => pages.effectiveParentId(pageId));
  const database = usePage(databaseId);
  const { ref, snapshot, loading } = useDatabase(database?.kind === 'database' ? databaseId : null);
  const queryCtx = useQueryContext(1, snapshot);
  const [renaming, setRenaming] = useState<string | null>(null);
  const afterAdd = useAfterMenuClose();
  if (!databaseId || database?.kind !== 'database') return null;
  if (loading || !ref || !snapshot) {
    return (
      <div className="flex flex-col gap-2 py-1" aria-busy="true" aria-label={t('loading')}>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-1/2" />
      </div>
    );
  }
  if (snapshot.meta.rowTemplateId === pageId) {
    return (
      <Callout tone="info">
        {t('rowTemplateNotice', { database: displayTitle(database.title) })}
      </Callout>
    );
  }
  const stored = snapshot.rows.find((candidate) => candidate.id === pageId);
  if (!stored) return null;
  // With its formula results (cached per row, so this stays cheap).
  const [row = stored] = withFormulaValues([stored], snapshot.properties, queryCtx);
  const properties = snapshot.properties.filter((property) => property.type !== 'title');
  const add = (type: PropertyType) =>
    runAction(ctx, () => {
      const property = addDatabaseProperty(ref, { type });
      afterAdd.schedule(() => setRenaming(property.id));
    });
  return (
    <section
      aria-label={t('rowProperties')}
      className="flex flex-col gap-0.5 border-b border-border pb-3"
    >
      {properties.map((property) => (
        <PropertyRow
          key={property.id}
          database={ref}
          snapshot={snapshot}
          row={row}
          property={property}
          queryCtx={queryCtx}
          readOnly={readOnly}
          renaming={renaming === property.id}
          setRenaming={(value) => setRenaming(value ? property.id : null)}
        />
      ))}
      {!readOnly ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-fit items-center gap-1.5 rounded-md px-1.5 text-ui text-fg-subtle hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
            >
              <Plus aria-hidden="true" className="size-4" />
              {t('addPropertyToRow')}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-80 overflow-y-auto"
            onCloseAutoFocus={afterAdd.onCloseAutoFocus}
          >
            {PICKABLE_TYPES.map((type) => (
              <DropdownMenuItem
                key={type}
                icon={<PropertyIcon type={type} />}
                onSelect={() => add(type)}
              >
                {typeLabel(type)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </section>
  );
}
