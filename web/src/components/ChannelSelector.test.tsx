import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChannelSelector } from "./ChannelSelector";

const channels = [
  { id: "cam-1", label: "Camera 1" },
  { id: "cam-2", label: "Camera 2" },
];

describe("ChannelSelector", () => {
  it("renders empty message when no channels exist", () => {
    render(
      <ChannelSelector
        channels={[]}
        selectedChannelId=""
        onSelectChannel={vi.fn()}
        enableDirectPpt={false}
        onChannelPttStart={vi.fn()}
        onChannelPttStop={vi.fn()}
        pttPressedChannelId={null}
      />,
    );

    expect(screen.getByText("No channels available")).toBeVisible();
  });

  it("selects a channel on pointer down when direct PTT is disabled", async () => {
    const user = userEvent.setup();
    const onSelectChannel = vi.fn();
    const onChannelPttStart = vi.fn();

    render(
      <ChannelSelector
        channels={channels}
        selectedChannelId="cam-1"
        onSelectChannel={onSelectChannel}
        enableDirectPpt={false}
        onChannelPttStart={onChannelPttStart}
        onChannelPttStop={vi.fn()}
        pttPressedChannelId={null}
      />,
    );

    await user.pointer([
      {
        target: screen.getByRole("button", { name: /TALK Camera 2/i }),
        keys: "[MouseLeft>]",
      },
      { keys: "[/MouseLeft]" },
    ]);

    expect(onSelectChannel).toHaveBeenCalledWith("cam-2");
    expect(onChannelPttStart).not.toHaveBeenCalled();
  });

  it("starts/stops PTT when direct PTT is enabled", async () => {
    const user = userEvent.setup();
    const onChannelPttStart = vi.fn();
    const onChannelPttStop = vi.fn();
    const onSelectChannel = vi.fn();

    render(
      <ChannelSelector
        channels={channels}
        selectedChannelId="cam-1"
        onSelectChannel={onSelectChannel}
        enableDirectPpt
        onChannelPttStart={onChannelPttStart}
        onChannelPttStop={onChannelPttStop}
        pttPressedChannelId="cam-2"
      />,
    );

    const channelButton = screen.getByRole("button", {
      name: /TALK Camera 2/i,
    });

    await user.pointer([
      { target: channelButton, keys: "[MouseLeft>]" },
      { target: channelButton, keys: "[/MouseLeft]" },
    ]);

    expect(onChannelPttStart).toHaveBeenCalledWith("cam-2");
    expect(onChannelPttStop).toHaveBeenCalledWith("cam-2");
    expect(onSelectChannel).not.toHaveBeenCalled();
  });
});
