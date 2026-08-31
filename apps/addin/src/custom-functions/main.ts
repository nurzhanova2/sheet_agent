import { HttpCustomFunctionGateway, CustomFunctionService, registerCustomFunctions } from "./service.js";

const endpoint = (import.meta.env.VITE_API_BASE_URL ?? "https://localhost:4000") + "/v1/custom-functions";
const gateway = new HttpCustomFunctionGateway(endpoint);
registerCustomFunctions(new CustomFunctionService(gateway));
