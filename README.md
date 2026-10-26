# SpeakUp 30 — Android app

A 30-day spoken English coach. You speak, it listens, corrects your mistakes, and talks back.

## What's inside

- **Accounts**: create an account or log in. Several people can share one phone, each with their own progress.
- **Today's 50**: 50 new conversations every day on the day's topic, plus review. You play one side of each conversation and speak your replies.
- **Instant correction**: after each reply you see what was wrong, the fix, a short reason, and a natural way to say it. The app can also say the correction out loud.
- **Say it again**: repeat the corrected sentence. The app checks which words it heard and gives you a match score.
- **Talk**: a hands-free voice call with Maya, your AI tutor. Choose today's topic, free talk, job interview, travel, office chat or friendly debate.
- **Mistakes**: every correction is saved, with your most repeated mistakes at the top.
- **30-day plan**: Week 1 basics → Week 4 fluency (CEFR A1 → C1). A missed day never skips a lesson.
- **Daily reminder** notification at a time you choose.

## Get the APK (no coding needed): build it free on GitHub

1. Create a free account at github.com.
2. Click **+ → New repository**, name it `speakup30`, and click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Unzip `SpeakUp30.zip` on your computer, open the `SpeakUp30` folder, select **everything inside it**, and drag it into the page. That includes the hidden `.github` folder: on Mac press Cmd+Shift+. to show it, and on Windows turn on View → Hidden items. Then click **Commit changes**.
4. Open the **Actions** tab. A job called **Build APK** starts by itself and takes about 5 minutes. If it doesn't, click **Build APK → Run workflow**.
5. When it shows a green tick, open the run and download **SpeakUp30-apk** at the bottom. It's a zip with `app-debug.apk` inside.
6. Send the APK to your phone, open it, and allow **Install unknown apps** when Android asks.

## Or build it with Android Studio

1. Install Android Studio from developer.android.com/studio.
2. **File → Open** and choose the `SpeakUp30` folder. Wait for the Gradle sync to finish.
3. Plug in your phone with USB debugging on and press **Run**, or use **Build → Build App Bundle(s) / APK(s) → Build APK(s)**.

## Turn on the AI coach

The app works offline with a built-in course and a checker for common mistakes. For 50 fresh AI conversations every day, the voice tutor, and detailed corrections:

1. Go to console.anthropic.com, sign up, add a little credit, and create an API key.
2. In the app, go to **Profile → AI coach**, paste the key, and tap **Save and test**.

The key is stored only on your phone and sent only to Anthropic. Haiku (the default) costs very little, roughly a few rupees a day for normal practice.

## Voice notes

- Speech recognition uses your phone's Google speech service. If the mic says it isn't available, install or update the **Google** app.
- For best results, speak at a normal pace in a quiet place. Pick Indian, American or British English in **Profile → Voice**.

## Project layout

- `app/src/main/assets/www/`: the app screens and logic (HTML, CSS, JavaScript)
- `app/src/main/java/com/speakup30/app/MainActivity.java`: native microphone, voice, permissions
- `app/src/main/java/com/speakup30/app/ReminderReceiver.java`: daily reminder
- `.github/workflows/build-apk.yml`: builds the APK on GitHub

## Publishing on Google Play (later)

The GitHub build makes a debug APK, which is fine for your own phone and for sharing with friends. To publish on the Play Store, create a signing key in Android Studio (**Build → Generate Signed App Bundle**) and upload the `.aab`. For cloud accounts that sync across phones, the next step is adding Firebase Authentication.

## Download

Latest APK: https://github.com/SatayamGiriProzo/jubilant-succotash/releases/latest/download/SpeakUp30.apk
