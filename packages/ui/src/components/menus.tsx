import { Check, ChevronRight } from 'lucide-react';
import {
  ContextMenu as ContextMenuPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
} from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { useEscapePastClosingLayer } from '../lib/escape';
import { KeyCombo } from './feedback';

const content =
  'z-[var(--tess-z-popover)] min-w-[12rem] overflow-hidden rounded-lg border border-border bg-surface p-1 text-fg shadow-popover outline-none data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out';
const item =
  'relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors duration-fast data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted';
const destructiveItem =
  'text-danger-text data-[highlighted]:bg-danger-subtle [&_svg]:text-danger-text';

interface ItemExtras {
  icon?: ReactNode;
  shortcut?: readonly string[];
  destructive?: boolean;
}

function ItemBody({ icon, shortcut, children }: ItemExtras & { children?: ReactNode }) {
  return (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut?.length ? <KeyCombo keys={shortcut} aria-hidden="true" className="ml-4" /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------------------------

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/**
 * A menu opened from a button.
 *
 * @example
 * <DropdownMenu>
 *   <DropdownMenuTrigger asChild><IconButton label={t('more')} icon={<MoreHorizontal />} /></DropdownMenuTrigger>
 *   <DropdownMenuContent align="end">
 *     <DropdownMenuItem icon={<Copy />} onSelect={duplicate}>{t('duplicate')}</DropdownMenuItem>
 *     <DropdownMenuSeparator />
 *     <DropdownMenuItem icon={<Trash2 />} destructive onSelect={trash}>{t('moveToTrash')}</DropdownMenuItem>
 *   </DropdownMenuContent>
 * </DropdownMenu>
 */
export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(content, className)}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  icon,
  shortcut,
  destructive,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & ItemExtras) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(item, destructive && destructiveItem, className)}
      {...props}
    >
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </DropdownMenuPrimitive.Item>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn(item, 'pr-8', className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DropdownMenuPrimitive.ItemIndicator className="absolute right-2">
        <Check aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(item, 'pr-8', className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DropdownMenuPrimitive.ItemIndicator className="absolute right-2">
        <Check aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('px-2 pt-2 pb-1 text-xs font-medium text-fg-subtle', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger({
  className,
  icon,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { icon?: ReactNode }) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(item, 'data-[state=open]:bg-hover', className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden="true" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        className={cn(content, className)}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------------

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

/** A right-click (long-press on touch) menu. Same item API as the dropdown menu. */
export function ContextMenuContent({
  className,
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Content>) {
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        className={cn(content, className)}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  icon,
  shortcut,
  destructive,
  children,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Item> & ItemExtras) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(item, destructive && destructiveItem, className)}
      {...props}
    >
      <ItemBody icon={icon} shortcut={shortcut}>
        {children}
      </ItemBody>
    </ContextMenuPrimitive.Item>
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return (
    <ContextMenuPrimitive.Label
      className={cn('px-2 pt-2 pb-1 text-xs font-medium text-fg-subtle', className)}
      {...props}
    />
  );
}

export function ContextMenuSubTrigger({
  className,
  icon,
  children,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & { icon?: ReactNode }) {
  return (
    <ContextMenuPrimitive.SubTrigger
      className={cn(item, 'data-[state=open]:bg-hover', className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden="true" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        className={cn(content, className)}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      />
    </ContextMenuPrimitive.Portal>
  );
}
