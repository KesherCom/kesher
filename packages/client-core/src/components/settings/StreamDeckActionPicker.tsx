import type { StreamDeckButtonAction } from "../../types";
import { Icon } from "../Icon";
import {
  actionCategories,
  actionChoiceOf,
  buildAction,
  choiceTarget,
  type ActionCategoryInfo,
  type ActionChoice,
  type ActionDefaults,
  type ActionTarget,
} from "../../lib/streamDeckActions";

export type PickerOption = { value: string; label: string };

export type StreamDeckActionPickerProps = {
  action: StreamDeckButtonAction | undefined;
  disabled?: boolean;
  /** Entries for the target pickers, in display order. */
  rooms: PickerOption[];
  users: PickerOption[];
  roles: PickerOption[];
  groups: PickerOption[];
  pages: PickerOption[];
  onChange: (next: StreamDeckButtonAction | undefined) => void;
  /** "Open a folder": make a new folder below this page for this key. */
  onNewFolder?: () => void;
};

const newFolderValue = "__new_folder__";

const targetLabels: Record<Exclude<ActionTarget, null>, string> = {
  line: "Party line",
  person: "Person",
  role: "Role",
  group: "Group",
  page: "Page",
};

/**
 * What a key does, in two steps: "with what" (party line, person, mic, ...)
 * then "what happens", each choice with one sentence of explanation. See
 * lib/streamDeckActions.ts.
 */
export function StreamDeckActionPicker({
  action,
  disabled,
  rooms,
  users,
  roles,
  groups,
  pages,
  onChange,
  onNewFolder,
}: StreamDeckActionPickerProps) {
  const { category, choice } = actionChoiceOf(action);
  const defaults: ActionDefaults = {
    roomId: rooms[0]?.value,
    userId: users[0]?.value,
    roleId: roles[0]?.value,
    broadcastGroupId: groups[0]?.value,
    firstPage: pages[0] ? Number(pages[0].value) : 0,
  };

  const pick = (nextCategory: ActionCategoryInfo, nextChoice: ActionChoice) =>
    onChange(buildAction(nextCategory, nextChoice, action, defaults));

  const target = choiceTarget(category, choice);
  const targetOptions: Record<Exclude<ActionTarget, null>, PickerOption[]> = {
    line: rooms,
    person: users,
    role: roles,
    group: groups,
    page: pages,
  };
  const targetValue = (() => {
    switch (target) {
      case "line":
        return action?.roomId ?? "";
      case "person":
        return action?.userId ?? "";
      case "role":
        return action?.roleId ?? "";
      case "group":
        return action?.broadcastGroupId ?? "";
      case "page":
        return String(action?.targetPage ?? 0);
      default:
        return "";
    }
  })();
  const setTarget = (value: string) => {
    if (value === newFolderValue) {
      onNewFolder?.();
      return;
    }
    if (!action) return;
    switch (target) {
      case "line":
        return onChange({ ...action, roomId: value });
      case "person":
        return onChange({ ...action, userId: value });
      case "role":
        return onChange({ ...action, roleId: value });
      case "group":
        return onChange({ ...action, broadcastGroupId: value });
      case "page":
        return onChange({ ...action, targetPage: Number(value) });
    }
  };

  const main = category.choices.filter((c) => !c.more);
  const more = category.choices.filter((c) => c.more);
  const renderChoice = (c: ActionChoice) => (
    <label key={c.id} className={`sd-choice${c.id === choice.id ? " active" : ""}`}>
      <input
        type="radio"
        name="sd-action-choice"
        checked={c.id === choice.id}
        disabled={disabled}
        onChange={() => pick(category, c)}
      />
      <span>
        <strong>{c.label}</strong>
        <small>{c.hint}</small>
      </span>
    </label>
  );

  return (
    <div className="sd-action">
      <div className="sd-categories" role="group" aria-label="Stream Deck function">
        {actionCategories.map((c) => (
          <button
            key={c.id}
            type="button"
            className="sd-category"
            aria-pressed={c.id === category.id}
            disabled={disabled}
            onClick={() => {
              if (c.id !== category.id) pick(c, c.choices[0]);
            }}
          >
            <Icon name={c.icon} />
            <span>{c.label}</span>
          </button>
        ))}
      </div>

      {target ? (
        <label className="streamdeck-control">
          <span>{targetLabels[target]}</span>
          <select
            aria-label={`Key ${targetLabels[target].toLowerCase()}`}
            value={targetValue}
            disabled={disabled}
            onChange={(event) => setTarget(event.target.value)}
          >
            {targetOptions[target].map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {target === "page" && onNewFolder ? (
              <option value={newFolderValue}>New folder…</option>
            ) : null}
          </select>
        </label>
      ) : null}

      {category.id !== "none" ? (
        <fieldset className="sd-choices">
          <legend>What happens</legend>
          {main.map(renderChoice)}
          {more.length > 0 ? (
            <details className="sd-more" open={!!choice.more}>
              <summary>More options</summary>
              {more.map(renderChoice)}
            </details>
          ) : null}
        </fieldset>
      ) : null}

      {action?.type === "volume_delta" ? (
        <label className="streamdeck-control">
          <span>Step per press</span>
          <select
            aria-label="Mic gain step"
            value={String(Math.abs(action.volumeDelta || 1))}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...action,
                volumeDelta: Math.sign(action.volumeDelta || 1) * Number(event.target.value),
              })
            }
          >
            <option value="1">1 dB</option>
            <option value="2">2 dB</option>
          </select>
        </label>
      ) : null}
    </div>
  );
}
