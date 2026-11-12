import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './button';
import { EmojiPicker, loadEmojiData } from './emoji-picker';
import {
  FeatureBoundary,
  bugReportUrl,
  describeError,
  setBugReportVersion,
} from './error-boundary';
import { Avatar, AvatarStack, Badge, EmptyState, KeyCombo, Spinner } from './feedback';
import { Field, Input } from './forms';
import { Select } from './select';
import { Checkbox, Switch } from './toggles';
import { ColorSwatches } from './color-swatches';
import { SidebarItem, SidebarSection } from './layout';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './menus';
import { ConfirmHost, Toaster, confirm, toast } from './notify';
import { Dialog, DialogContent, DialogTitle, TooltipProvider } from './overlays';

describe('buttons', () => {
  it('renders variants, loading state and accessible icon buttons', async () => {
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <Button variant="primary" onClick={onClick}>
          Save
        </Button>
        <Button loading>Busy</Button>
        <IconButton label="New page" icon={<svg />} />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Busy/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Busy/ })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'New page' })).toHaveAttribute('type', 'button');
  });
});

describe('feedback components', () => {
  it('renders spinner, badge, avatars, key combos and empty states', async () => {
    render(
      <div>
        <Spinner />
        <Badge tone="green">Done</Badge>
        <Avatar name="Ada Lovelace" color="#0090ff" />
        <AvatarStack
          people={[1, 2, 3, 4, 5].map((n) => ({ id: String(n), name: `Person ${n}` }))}
          max={3}
        />
        <KeyCombo keys={['⌘', 'K']} />
        <EmptyState
          title="Nothing here"
          description="Create a page to get started."
          actions={<Button>Create</Button>}
        />
      </div>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(await screen.findByText('AL')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('⌘')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
  });
});

describe('form controls', () => {
  it('wires labels, descriptions and errors for screen readers', () => {
    render(
      <Field label="Display name" description="Shown to collaborators" error="Required">
        {(props) => <Input {...props} defaultValue="" />}
      </Field>,
    );
    const input = screen.getByLabelText('Display name');
    expect(input).toHaveAccessibleDescription('Shown to collaborators Required');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('toggles checkboxes and switches and renders selects', async () => {
    function Controls() {
      const [checked, setChecked] = useState(false);
      const [on, setOn] = useState(false);
      return (
        <>
          <Checkbox
            aria-label="Done"
            checked={checked}
            onCheckedChange={(value) => setChecked(value === true)}
          />
          <Switch aria-label="Full width" checked={on} onCheckedChange={setOn} />
          <Select
            aria-label="Theme"
            value="light"
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </>
      );
    }
    render(<Controls />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked();
    await userEvent.click(screen.getByRole('switch', { name: 'Full width' }));
    expect(screen.getByRole('switch', { name: 'Full width' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveTextContent('Light');
  });

  it('picks colors from swatches', async () => {
    const onChange = vi.fn();
    render(
      <ColorSwatches
        label="Color"
        colors={['#ff0000', '#00ff00']}
        value="#ff0000"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('radio', { name: '#00ff00' }));
    expect(onChange).toHaveBeenCalledWith('#00ff00');
  });
});

describe('sidebar primitives', () => {
  it('renders items with the current page state and collapsible sections', async () => {
    render(
      <SidebarSection title="Favorites" collapsible>
        <SidebarItem label="Roadmap" active />
      </SidebarSection>,
    );
    expect(screen.getByRole('button', { name: 'Roadmap' })).toHaveAttribute('aria-current', 'page');
    const toggle = screen.getByRole('button', { name: 'Favorites' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
  });
});

describe('overlays and menus', () => {
  it('opens a dialog with an accessible title and close button', () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Rename</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Rename' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('opens a dropdown menu from the keyboard and selects items', async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>More</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect} shortcut={['⌘', 'D']}>
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem destructive>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'More' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await screen.findByRole('menuitem', { name: /Duplicate/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('toasts and confirmations', () => {
  it('shows toasts with actions', async () => {
    render(<Toaster />);
    const undo = vi.fn();
    act(() => {
      toast({
        title: 'Moved to trash',
        variant: 'success',
        action: { label: 'Undo', onClick: undo },
      });
    });
    expect(await screen.findByText('Moved to trash')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('resolves confirmations once each, in order', async () => {
    render(<ConfirmHost />);
    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(false);
    act(() => {
      first = confirm({ title: 'Delete forever?', confirmLabel: 'Delete', destructive: true });
      second = confirm({ title: 'Empty trash?' });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await expect(first).resolves.toBe(true);
    expect(await screen.findByText('Empty trash?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(second).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});

describe('FeatureBoundary', () => {
  it('contains crashes and retries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    function Fragile() {
      if (fail) throw new Error('database view exploded');
      return <p>Recovered</p>;
    }
    render(
      <div>
        <p>Rest of the app</p>
        <FeatureBoundary featureId="databases">
          <Fragile />
        </FeatureBoundary>
      </div>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The databases part of Tessera ran into an error',
    );
    expect(screen.getByText('database view exploded')).toBeInTheDocument();
    expect(screen.getByText('Rest of the app')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered')).toBeInTheDocument();
    expect(describeError(new Error('x'), { Feature: 'y' })).toContain('Feature: y');
    error.mockRestore();
  });

  it('links to a bug report prefilled with the error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setBugReportVersion('0.1.0');
    function Broken(): never {
      throw new Error('graph layout failed');
    }
    render(
      <FeatureBoundary featureId="graph">
        <Broken />
      </FeatureBoundary>,
    );
    const link = screen.getByRole('link', { name: 'Report on GitHub' });
    expect(link).toHaveAttribute('target', '_blank');
    const url = new URL(link.getAttribute('href') ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://github.com/femboypuppy/Tessera-Notes/issues/new',
    );
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('title')).toBe('[Bug]: graph layout failed');
    expect(url.searchParams.get('version')).toBe('0.1.0');
    expect(url.searchParams.get('what-happened')).toContain('graph layout failed');
    expect(url.searchParams.get('diagnostics')).toContain('Feature: graph');
    // Long stacks are cut so the link stays under GitHub's URL limit.
    const huge = new Error('boom');
    huge.stack = 'x'.repeat(50_000);
    expect(bugReportUrl(huge).length).toBeLessThan(8_000);
    error.mockRestore();
  });
});

describe('EmojiPicker', () => {
  it('loads emoji, filters, navigates with the keyboard and picks', async () => {
    const data = await loadEmojiData();
    expect(data.emojis.length).toBeGreaterThan(1500);
    expect(data.groups.map((group) => group.key)).toContain('food-drink');
    const onSelect = vi.fn();
    render(<EmojiPicker onSelect={onSelect} onRemove={vi.fn()} />);
    const search = screen.getByRole('searchbox', { name: 'Search emoji' });
    // Find the button by its label, then check its role and accessible name: the same assertion
    // as getAllByRole('button', { name }), which computes the accessible name of all ~1,870
    // buttons and took 10 s of this test in jsdom.
    const [grinning] = await screen.findAllByLabelText('grinning face');
    expect(grinning).toHaveRole('button');
    expect(grinning).toHaveAccessibleName('grinning face');
    await userEvent.type(search, 'rocket');
    const rocket = await screen.findByRole('button', { name: 'rocket' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rocket);
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('🚀');
    await userEvent.clear(search);
    await userEvent.type(search, 'zzzz-no-emoji');
    expect(await screen.findByText('No emoji found')).toBeInTheDocument();
  });

  it('picks the first result of an Enter pressed while the emoji are still loading', async () => {
    const onSelect = vi.fn();
    render(<EmojiPicker onSelect={onSelect} />);
    const search = screen.getByRole('searchbox', { name: 'Search emoji' });
    expect(screen.getByText('Loading emoji…')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'rocket' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('🚀'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('drops a pending Enter when the query changes before the emoji load', async () => {
    const onSelect = vi.fn();
    render(<EmojiPicker onSelect={onSelect} />);
    const search = screen.getByRole('searchbox', { name: 'Search emoji' });
    expect(screen.getByText('Loading emoji…')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'rocket' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.change(search, { target: { value: 'pizza' } });
    await screen.findByRole('button', { name: 'pizza' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
