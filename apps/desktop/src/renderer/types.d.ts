interface DesktopBridge {
	version: string;
	apiBaseUrl: string;
}

interface Window {
	desktopApi: DesktopBridge;
}

declare module "*.css";
declare module "*?url" {
	const value: string;
	export default value;
}
