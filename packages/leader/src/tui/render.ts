import React from "react";
import { render } from "ink";
import type { IMessageRouter, InstanceId } from "@co/contracts";
import type { LeaderState } from "../state.js";
import type { StateStore } from "./store.js";
import App from "./app.js";

export interface InkTuiInstance {
  store: StateStore;
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
}

export function renderInkTui(opts: {
  state: LeaderState;
  store: StateStore;
  messageRouter: IMessageRouter;
  leaderId: InstanceId;
  leaderName: string;
}): InkTuiInstance {
  const { waitUntilExit, unmount } = render(
    React.createElement(App, {
      store: opts.store,
      state: opts.state,
      messageRouter: opts.messageRouter,
      leaderId: opts.leaderId,
      leaderName: opts.leaderName,
    }),
    { exitOnCtrlC: false },
  );

  return {
    store: opts.store,
    unmount,
    waitUntilExit,
  };
}
