/**
 * What a Stream Deck key can do, as the layout editor offers it: first
 * "with what" (a category), then "what happens" (a choice with one sentence
 * of explanation). The stored action types do not change; this only groups
 * and names them.
 */
import type { StreamDeckActionType, StreamDeckButtonAction } from "../types";
import type { IconName } from "../components/Icon";

export type ActionCategory =
  | "none"
  | "line"
  | "person"
  | "role"
  | "group"
  | "calls"
  | "mic"
  | "pages";

/** What the category needs picked before the choice (a party line, ...). */
export type ActionTarget = "line" | "person" | "role" | "group" | "page" | null;

export type ActionChoice = {
  /** Unique per category; equals the action type except for mic gain. */
  id: string;
  type: StreamDeckActionType;
  label: string;
  hint: string;
  /** Rarely used: shown under "More options". */
  more?: boolean;
  /** Mic gain: the direction this choice stands for. */
  direction?: 1 | -1;
  target?: ActionTarget;
};

export type ActionCategoryInfo = {
  id: ActionCategory;
  label: string;
  icon: IconName;
  target: ActionTarget;
  choices: ActionChoice[];
};

export const actionCategories: ActionCategoryInfo[] = [
  {
    id: "none",
    label: "Nothing",
    icon: "close",
    target: null,
    choices: [{ id: "none", type: "none", label: "Nothing", hint: "The key stays empty." }],
  },
  {
    id: "line",
    label: "Party line",
    icon: "headphones",
    target: "line",
    choices: [
      {
        id: "ptt_room",
        type: "ptt_room",
        label: "Talk",
        hint: "Hold the key to talk on this party line.",
      },
      {
        id: "listen_room",
        type: "listen_room",
        label: "Listen on / off",
        hint: "Press to start or stop hearing this party line.",
      },
      {
        id: "call_room",
        type: "call_room",
        label: "Call",
        hint: "Press to signal everyone on this party line.",
      },
      {
        id: "select_talk_room",
        type: "select_talk_room",
        label: "Choose for talking",
        hint: "Press to add or remove this line from the lines a \"Talk on chosen lines\" key talks on.",
        more: true,
      },
      {
        id: "select_listen_room",
        type: "select_listen_room",
        label: "Choose, hold to listen",
        hint: "Press to choose this line for talking; hold to listen while held.",
        more: true,
      },
      {
        id: "ptt_selected",
        type: "ptt_selected",
        label: "Talk on chosen lines",
        hint: "Hold to talk on the lines chosen with \"Choose for talking\". Needs no party line here.",
        more: true,
        target: null,
      },
    ],
  },
  {
    id: "person",
    label: "Person",
    icon: "user",
    target: "person",
    choices: [
      {
        id: "direct_user",
        type: "direct_user",
        label: "Talk",
        hint: "Hold the key to talk to this person only.",
      },
    ],
  },
  {
    id: "role",
    label: "Role",
    icon: "users",
    target: "role",
    choices: [
      {
        id: "direct_role",
        type: "direct_role",
        label: "Talk",
        hint: "Hold the key to talk to everyone logged in with this role.",
      },
    ],
  },
  {
    id: "group",
    label: "Group",
    icon: "broadcast",
    target: "group",
    choices: [
      {
        id: "broadcast_ptt",
        type: "broadcast_ptt",
        label: "Announce",
        hint: "Hold the key to talk on every party line of this group at once.",
      },
    ],
  },
  {
    id: "calls",
    label: "Calls",
    icon: "bell",
    target: null,
    choices: [
      {
        id: "reply_to_caller",
        type: "reply_to_caller",
        label: "Reply",
        hint: "Hold the key to talk back to whoever called you last.",
      },
      {
        id: "incoming_call_indicator",
        type: "incoming_call_indicator",
        label: "Show incoming calls",
        hint: "The key lights up and shows who calls you. Pressing it does nothing.",
      },
    ],
  },
  {
    id: "mic",
    label: "Microphone",
    icon: "mic",
    target: null,
    choices: [
      {
        id: "mute_toggle",
        type: "mute_toggle",
        label: "Open mic on / off",
        hint: "Press to switch between hold-to-talk and an always open microphone.",
      },
      {
        id: "volume_up",
        type: "volume_delta",
        label: "Louder",
        hint: "Each press raises your microphone level.",
        direction: 1,
      },
      {
        id: "volume_down",
        type: "volume_delta",
        label: "Quieter",
        hint: "Each press lowers your microphone level.",
        direction: -1,
      },
    ],
  },
  {
    id: "pages",
    label: "Pages",
    icon: "grid",
    target: null,
    choices: [
      { id: "page_up", type: "page_up", label: "Next page", hint: "Shows the next page of keys." },
      {
        id: "page_down",
        type: "page_down",
        label: "Previous page",
        hint: "Shows the previous page of keys.",
      },
      { id: "page_home", type: "page_home", label: "First page", hint: "Back to the first page." },
      {
        id: "page_jump",
        type: "page_jump",
        label: "Open a folder or page",
        hint: "Opens a folder of more keys (pick \"New folder…\" to make one) or another page.",
        target: "page",
      },
    ],
  },
];

const categoryById = new Map(actionCategories.map((c) => [c.id, c]));

export function actionCategory(id: ActionCategory): ActionCategoryInfo {
  return categoryById.get(id) ?? actionCategories[0];
}

/** The category and choice a stored action belongs to. */
export function actionChoiceOf(action: StreamDeckButtonAction | undefined): {
  category: ActionCategoryInfo;
  choice: ActionChoice;
} {
  const type = action?.type ?? "none";
  for (const category of actionCategories) {
    for (const choice of category.choices) {
      if (choice.type !== type) continue;
      if (choice.direction && Math.sign(action?.volumeDelta ?? 1) !== choice.direction) {
        continue;
      }
      return { category, choice };
    }
  }
  const none = actionCategories[0];
  return { category: none, choice: none.choices[0] };
}

/** What the chosen choice needs picked: its own target or the category's. */
export function choiceTarget(category: ActionCategoryInfo, choice: ActionChoice): ActionTarget {
  return choice.target !== undefined ? choice.target : category.target;
}

/** First entries to fall back on when a choice needs a target. */
export type ActionDefaults = {
  roomId?: string;
  userId?: string;
  roleId?: string;
  broadcastGroupId?: string;
  /** The first page of the layout. */
  firstPage?: number;
};

/**
 * The action a key gets for a choice, keeping what still fits from the
 * previous action (the same party line when switching Talk to Listen, the
 * gain step when switching Louder to Quieter).
 */
export function buildAction(
  category: ActionCategoryInfo,
  choice: ActionChoice,
  previous: StreamDeckButtonAction | undefined,
  defaults: ActionDefaults,
): StreamDeckButtonAction | undefined {
  if (choice.type === "none") return undefined;
  const type = choice.type;
  switch (choiceTarget(category, choice)) {
    case "line":
      return { type, roomId: previous?.roomId ?? defaults.roomId };
    case "person":
      return { type, userId: previous?.userId ?? defaults.userId };
    case "role":
      return { type, roleId: previous?.roleId ?? defaults.roleId };
    case "group":
      return {
        type,
        broadcastGroupId: previous?.broadcastGroupId ?? defaults.broadcastGroupId,
      };
    case "page":
      return {
        type,
        targetPage:
          previous?.type === "page_jump" && previous.targetPage !== undefined
            ? previous.targetPage
            : (defaults.firstPage ?? 0),
      };
    default:
      break;
  }
  if (type === "page_home") {
    return { type, targetPage: defaults.firstPage ?? 0 };
  }
  if (type === "volume_delta") {
    const step =
      previous?.type === "volume_delta" ? Math.abs(previous.volumeDelta || 1) : 1;
    return { type, volumeDelta: (choice.direction ?? 1) * step };
  }
  return { type };
}
