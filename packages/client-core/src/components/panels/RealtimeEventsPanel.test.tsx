import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RealtimeEventsPanel } from "./RealtimeEventsPanel";

describe("RealtimeEventsPanel", () => {
  it("renders heading and event rows", () => {
    render(
      <RealtimeEventsPanel
        events={[
          { at: "10:01", label: "Connected" },
          { at: "10:02", label: "Mic enabled" },
        ]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Realtime events" }),
    ).toBeVisible();
    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.getByText("Mic enabled")).toBeVisible();
    expect(screen.getByText("10:01")).toBeVisible();
    expect(screen.getByText("10:02")).toBeVisible();
  });
});
