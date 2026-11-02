# Put Connection Lab online

**Goal:** Connection Lab at `https://connection-lab.rangner.com`

**Time:** about 20 minutes

**Use:** your Windows PC

> **The one rule:** never upload into `httpd.www` itself. That is your portfolio. Uploading there replaces it.

---

## Part 1: Make the file

Do this after GitHub and the other links are in the code.

1. Open the project in VS Code.
2. Open **Terminal → New Terminal**.
3. Type this and press Enter:

   ```
   npm run site
   ```

4. Wait for a line ending in `KB`.

Your two files are now here:

`D:\dev\interactive-educator\dist-bundle\site\`

- `index.html`
- `cat.jpg`

---

## Part 2: Make the subdomain

1. Log in at **one.com**.
2. Open **Domain → Subdomains**.
   Not there? Try **Advanced settings → Subdomains**.
   Still not there? Go to **Plan B** at the bottom.
3. Add this name:

   ```
   connection-lab
   ```

4. Save.
5. Find **connection-lab** in the list.
6. Write down the name in its **Folder** column. It can look like random letters and numbers.

---

## Part 3: Upload the files

1. Open **filemanager.one.com**.
   Or in one.com: **Hosting settings → File Manager**.
2. Open the folder you wrote down in Part 2.
3. **Check:** the folder must be empty.
   See your portfolio's files? **Stop.** You are in the wrong folder.
4. Click **Upload**.
5. Choose **both** `index.html` and `cat.jpg` from Part 1.
6. Wait until both finish.

---

## Part 4: Check it

1. On your phone, open `https://connection-lab.rangner.com`
2. Connection Lab should appear.
3. Open `https://rangner.com`
4. Your portfolio should appear, the same as before.
5. Open `https://connection-lab.rangner.com/cat.jpg`
6. A yawning cat should appear.

**Connection Lab doesn't appear, or you get a security warning?**
Wait. It can take up to 24 hours. If it still fails after that, use **Plan B**.

---

## Part 5: One last step

Do this once, the first time.

1. **Don't share the link yet.**
2. Tell Claude the site is up.
3. Claude records the cat from your site and makes a new `index.html`.
4. Follow **Updating the site later** below.

**Now you're done.** You can share the link.

---

## Plan B: Use a folder

Your address will be `https://rangner.com/connection-lab/`

1. Open **filemanager.one.com**.
2. Open `httpd.www`.
3. Create a new folder called `connection-lab`.
4. **Open that new folder.** Check that its name shows at the top.
5. Upload `index.html` and `cat.jpg` into it.
6. Open `https://rangner.com/connection-lab/`
7. Open `https://rangner.com` and check that your portfolio is still there.
8. Open `https://rangner.com/connection-lab/cat.jpg` and check that a yawning cat appears.
9. Do **Part 5**.

---

## Updating the site later

1. Do Part 1 again.
2. Open the same folder as before.
3. Upload the new `index.html`. You don't need to upload `cat.jpg` again.
4. Choose to replace the old one.

Still seeing the old version? Wait a few minutes and reload.

---

## If something looks wrong

Stop. Don't delete anything. Ask Claude.
