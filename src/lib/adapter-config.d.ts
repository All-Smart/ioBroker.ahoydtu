// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			host: string;
			port: number;
			pollInterval: number;
			password: string;
		}
	}
}

// this is required so the above is a module augmentation
export {};
