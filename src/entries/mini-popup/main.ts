import { createApp } from "vue";
import { i18nInstance as i18n } from "@/options/plugins/i18n.ts";
import App from "./App.vue";

createApp(App).use(i18n).mount("#app");
