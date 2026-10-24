# Marginalia on your Android phone

The phone version runs entirely on the phone. Your sources, cards, quizzes and marks are stored on
the phone, and answers come straight from Google Gemini with your own free key. There's no server,
no account and nothing to pay.

There are two ways to get it, both free:

- **Android app (APK)**: built in the cloud by GitHub Actions. It has the native camera, vibration
  and a daily "cards due" reminder.
- **Web app (PWA)**: hosted on GitHub Pages. Open the link in Chrome, then tap "Install app".
  It works offline once it's installed.

## One-time setup (about 10 minutes, on a computer)

1. **Create the repository.** On github.com, click **New repository**.
   - Name it `marginalia`.
   - Make it **Public** (free GitHub Pages needs that; no secrets are in the code).
   - Don't add a README.
2. **Push the code.** From the `Study tool` folder:
   ```bash
   git remote add origin https://github.com/josejoshy2007-spec/marginalia.git
   git push -u origin main
   ```
   The first push opens a browser window to sign in to GitHub.
3. **Add the signing key.** This lets each new APK install over the old one.
   - Go to repo **Settings → Secrets and variables → Actions → New repository secret**.
   - Add these two secrets:
     - `ANDROID_KEYSTORE_BASE64`: paste the whole contents of `android-signing/ANDROID_KEYSTORE_BASE64.txt`
     - `ANDROID_KEYSTORE_PASSWORD`: paste the contents of `android-signing/ANDROID_KEYSTORE_PASSWORD.txt`
   - Back up the `android-signing` folder somewhere private, such as Google Drive. If you lose it,
     future updates can't install over the existing app; you'd have to uninstall it and lose the
     data on the phone.
4. **Turn on Pages.** Go to repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
5. **Run the builds.** Go to the **Actions** tab. If the two workflows didn't start after the push
   (or started before the secrets existed), open **Android APK → Run workflow**, then
   **Web app (GitHub Pages) → Run workflow**. The APK build takes about 6–10 minutes.

## Install the APK on your phone

1. On the phone, open
   `https://github.com/josejoshy2007-spec/marginalia/releases/latest/download/marginalia.apk`.
   You can also go to the repo's **Releases** page and tap `marginalia.apk`.
2. Chrome warns that the file can harm your device. Tap **Download anyway**.
3. Open the downloaded file. Android asks to **allow installs from this source** (Chrome or Files).
   Turn it on, go back, and tap **Install**.
4. Play Protect may say the app is from an unknown developer. Tap **More details → Install anyway**.
   This happens because you built it yourself rather than getting it from the Play Store.
5. Open **Marginalia**. On the welcome screen, paste your Gemini key (free from
   aistudio.google.com/apikey) and tap **Save key**.
6. Allow notifications when asked, if you want the daily review reminder. Allow the camera and
   microphone the first time you photograph an answer or record a lecture.

**Updating:** every push to `main` builds a new release. Open the same link, download, and install
over the old app. Your data stays.

## Or install the web app (PWA)

Open `https://josejoshy2007-spec.github.io/marginalia/` in Chrome on the phone, then tap
**⋮ → Install app** (or **Add to Home screen**). The PWA is a separate install from the APK with its
own storage. Reminders and the native camera sheet only work in the APK.

## Move your laptop library to the phone

1. With the laptop API running, open `http://localhost:8000/export` in a browser. It downloads
   `marginalia-laptop-<date>.json`.
2. Get that file onto the phone (Google Drive, email or USB).
3. In the app, open **Settings** (the dial icon at the bottom of the rail) → **Import backup** and
   pick the file.

Subjects, sources, cards (with their review schedule), quizzes, exams and summaries come across. The
phone then re-indexes the sources for search in the background, which uses a little of your Gemini
quota. Studio audio isn't copied; render it again in Listen.

Use **Settings → Export backup** on the phone now and then, and save it to Drive. The library lives
only on the phone.

## Things to know

- **Free Gemini quota is small.** The main model allows roughly 20 requests a day on the free tier;
  after that the app switches to the backup model. If both are used up, it says so; the quota resets
  at midnight Pacific time (3–4 pm in China). Recall cards, reading and reviewing don't use quota.
- **Lecture recordings** are transcribed by Gemini instead of Whisper: uploaded once, then
  transcribed in 20-minute parts, up to 3 hours. A 2-hour lecture takes about 6 requests.
- **Big textbooks** are read on the phone, one page at a time. A 900-page book takes a few minutes to
  read and then indexes in batches. If Gemini's per-minute limit is hit, the app waits and carries on.
  If the app is closed midway, it resumes the next time it opens.
- **Scanned PDFs** (photos of pages, no text layer) still aren't supported.
