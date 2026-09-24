// Only for local testing (e.g. `npm start`). Vercel itself does NOT use
// this file — it imports api/index.js directly as a serverless function.
const app = require("./api/index.js");

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`DELTA.KEYS local dev server running on http://localhost:${PORT}`);
  console.log("Note: on Vercel, api/index.js is used directly — this file is for local testing only.");
});
