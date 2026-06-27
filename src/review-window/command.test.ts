// SPDX-License-Identifier: MIT
// Smoke test for the native Glimpse /review-diff command registration.

import { describe, expect, it, vi } from "vitest";

import { registerReviewWindowCommand } from "./command.js";

vi.mock("glimpseui", () => ({
	open: vi.fn(() => ({
		send: () => {},
		on: () => {},
		removeListener: () => {},
		close: () => {},
	})),
}));

interface RegisteredCommand {
	description?: string;
	handler?: (...args: unknown[]) => unknown;
}

describe("registerReviewWindowCommand", () => {
	it("registers a /review-diff command on the given pi", () => {
		const commands: Record<string, RegisteredCommand> = {};
		const pi = {
			registerCommand(name: string, spec: RegisteredCommand) {
				commands[name] = spec;
			},
			on() {},
		};

		registerReviewWindowCommand(pi as never);

		expect(commands["review-diff"]).toBeDefined();
		expect(typeof commands["review-diff"].description).toBe("string");
		expect(typeof commands["review-diff"].handler).toBe("function");
	});
});
