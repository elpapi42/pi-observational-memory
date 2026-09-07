import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SmokeGlobals = typeof globalThis & {
	__omSmokeObservationalNotificationCount?: number;
};

export default function notificationProbe(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const globals = globalThis as SmokeGlobals;
		globals.__omSmokeObservationalNotificationCount = 0;
		const notify = ctx.ui.notify.bind(ctx.ui);
		ctx.ui.notify = (message, type) => {
			if (message.startsWith("Observational memory:")) {
				globals.__omSmokeObservationalNotificationCount =
					(globals.__omSmokeObservationalNotificationCount ?? 0) + 1;
			}
			notify(message, type);
		};
	});
}
