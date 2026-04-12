declare module "bcryptjs";
declare module "pdf-parse";

declare namespace Express {
	interface Request {
		user?: {
			id: string;
			email: string;
		};
		file?: Multer.File;
	}
}
