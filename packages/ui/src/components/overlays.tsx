import { X } from 'lucide-react';
import {
  AlertDialog as AlertDialogPrimitive,
  Dialog as DialogPrimitive,
  HoverCard as HoverCardPrimitive,
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import { useRef, type ComponentProps, type ReactNode } from 'react';
import { tUi } from '../i18n/index';
import { cn } from '../lib/cn';
import { useEscapePastClosingLayer } from '../lib/escape';
import { buttonVariants } from './button-variants';
import { KeyCombo } from './feedback';

const floating =
  'z-[var(--tess-z-popover)] rounded-lg border border-border bg-surface text-fg shadow-popover outline-none data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out';

// ---------------------------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------------------------

/** Mount once near the root (the shell does). */
export function TooltipProvider({
  children,
  delayDuration = 400,
}: {
  children: ReactNode;
  delayDuration?: number;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * A tooltip for a single focusable child. Keep content short; never put essential information
 * only in a tooltip.
 *
 * @example
 * <Tooltip content={t('newPage')} shortcut={formatShortcut('Mod+N', isApple)}><button>…</button></Tooltip>
 */
export function Tooltip({
  content,
  shortcut,
  side = 'bottom',
  children,
}: {
  content: ReactNode;
  shortcut?: readonly string[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[var(--tess-z-tooltip)] flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg shadow-popover data-[state=delayed-open]:animate-fade-in"
        >
          {content}
          {shortcut?.length ? (
            <KeyCombo
              keys={shortcut}
              className="opacity-80 [&_kbd]:border-transparent [&_kbd]:bg-bg/15 [&_kbd]:text-bg"
            />
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------------------------
// Popover and hover card
// ---------------------------------------------------------------------------------------------

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

/** Floating content anchored to a trigger. */
export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(floating, 'p-2', className)}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      />
    </PopoverPrimitive.Portal>
  );
}

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

/** A preview card on hover (link previews). */
export function HoverCardContent({
  className,
  sideOffset = 8,
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof HoverCardPrimitive.Content>) {
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        sideOffset={sideOffset}
        className={cn(floating, 'w-80 p-3', className)}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      />
    </HoverCardPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------------------------

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

function Overlay({ className }: { className?: string }) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-[var(--tess-z-overlay)] bg-overlay data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in',
        className,
      )}
    />
  );
}

/**
 * A modal dialog. Always include a `DialogTitle` (hide it visually with `VisuallyHidden` if needed).
 *
 * @example
 * <Dialog open={open} onOpenChange={setOpen}>
 *   <DialogContent>
 *     <DialogHeader><DialogTitle>{t('rename')}</DialogTitle></DialogHeader>
 *     …
 *     <DialogFooter><DialogClose asChild><Button>{t('done')}</Button></DialogClose></DialogFooter>
 *   </DialogContent>
 * </Dialog>
 */
export function DialogContent({
  className,
  children,
  showClose = true,
  size = 'md',
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  showClose?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-[12vh] left-1/2 z-[var(--tess-z-overlay)] flex max-h-[76vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-dialog outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
          width,
          className,
        )}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            aria-label={tUi('close')}
            className="duration-fast absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 px-5 pt-5 pr-12 pb-2', className)} {...props} />;
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-2', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-wrap items-center justify-end gap-2 px-5 pt-3 pb-5', className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-base font-semibold text-fg', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn('text-ui text-fg-muted', className)} {...props} />
  );
}

// ---------------------------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------------------------

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

/**
 * A modal panel that slides in from the left or right edge (the sidebar drawer at phone width, a
 * side panel on small screens). It traps focus and closes on Escape or a click outside. `title`
 * names it for screen readers and is not shown.
 *
 * On close, focus returns to the element that had it when the sheet opened (a `SheetTrigger` is
 * optional). If the user went somewhere instead (for example the sheet opened a page that focused
 * its title), focus stays there.
 *
 * @example
 * <Sheet open={open} onOpenChange={setOpen}>
 *   <SheetContent side="left" title={t('sidebar')}><Sidebar /></SheetContent>
 * </Sheet>
 */
export function SheetContent({
  side = 'left',
  title,
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { side?: 'left' | 'right'; title: string }) {
  const opener = useRef<HTMLElement | null>(null);
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          // Runs before focus moves into the sheet.
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const active = document.activeElement;
          if (active && active !== document.body) return;
          if (opener.current?.isConnected) opener.current.focus();
        }}
        className={cn(
          'fixed inset-y-0 z-[var(--tess-z-overlay)] flex w-[min(85vw,20rem)] flex-col bg-surface text-fg shadow-dialog outline-none data-[state=closed]:animate-fade-out',
          side === 'left'
            ? 'left-0 data-[state=open]:animate-slide-in-left'
            : 'right-0 data-[state=open]:animate-slide-in-right',
          className,
        )}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------------------------
// Alert dialog
// ---------------------------------------------------------------------------------------------

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

/** A confirmation dialog for destructive or important actions (focus starts on Cancel). */
export function AlertDialogContent({
  className,
  children,
  ref,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  const escape = useEscapePastClosingLayer(onEscapeKeyDown, ref);
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className="fixed inset-0 z-[var(--tess-z-overlay)] bg-overlay data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
      <AlertDialogPrimitive.Content
        className={cn(
          'fixed top-[20vh] left-1/2 z-[var(--tess-z-overlay)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-border bg-surface p-5 text-fg shadow-dialog outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
          className,
        )}
        {...props}
        ref={escape.ref}
        onEscapeKeyDown={escape.onEscapeKeyDown}
      >
        {children}
      </AlertDialogPrimitive.Content>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title className={cn('text-base font-semibold', className)} {...props} />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn('mt-1.5 text-ui text-fg-muted', className)}
      {...props}
    />
  );
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-5 flex justify-end gap-2', className)} {...props} />;
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: 'secondary' }), className)}
      {...props}
    />
  );
}

export function AlertDialogAction({
  className,
  destructive,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Action> & { destructive?: boolean }) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants({ variant: destructive ? 'danger' : 'primary' }), className)}
      {...props}
    />
  );
}
