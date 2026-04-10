interface DesktopBridge {
	version: string;
	apiBaseUrl: string;
}

interface Window {
	desktopApi: DesktopBridge;
}

declare module "*.css";
