import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from 'axios-cookiejar-support';
import fs from "fs";
import Path from "path";
import { mkdirp } from "mkdirp";
import { RateLimit } from "async-sema";
import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import { ExifTool } from 'exiftool-vendored';
import { format } from 'date-fns';

dotenv.config();
const exiftool = new ExifTool();

const __dirname = Path.dirname(fileURLToPath(import.meta.url));

const cookieJar = new CookieJar();
const client = wrapper(axios.create({ jar: cookieJar, withCredentials: true }));

const LOGIN_URL = "https://home.classdojo.com/api/session";
const FEED_BASE_URL = "https://home.classdojo.com/api/storyFeed?includePrivate=true";

const IMAGE_DIR = "images";
const VIDEO_DIR = "videos";
const MAX_FEEDS = 30;
const CONCURRENCY = 15;
const LIMITER = RateLimit(CONCURRENCY);
const STUDENTS = process.env.STUDENTS ? process.env.STUDENTS.split(',') : [];

let feedsProcessed = 0;

async function main() {
    try {
        await login();
    } catch (error) {
        console.error("Failed to login to ClassDojo, double check your .env file", error);
        process.exit();
    }

    while (feedsProcessed < MAX_FEEDS) {
        for (const studentId of STUDENTS) {
            const studentFeedUrl = `${FEED_BASE_URL}&studentId=${studentId}`;

            console.log(`processing feed for student ${studentId}: ${studentFeedUrl}...`);
            try {
                await processFeed(studentFeedUrl, studentId);
            } catch (error) {
                console.error(`Couldn't process feed for student ${studentId}`, error);
            }
        }
        feedsProcessed++;
    }
}

async function login() {
    checkEnv("DOJO_EMAIL");
    checkEnv("DOJO_PASSWORD");

    function checkEnv(variable) {
        if (!process.env[variable]) {
            throw new Error(`${variable} not set in the .env file. Please follow the instructions on the README of the project.`);
        }
    }

    return await client.post(LOGIN_URL, {
        login: process.env.DOJO_EMAIL,
        password: process.env.DOJO_PASSWORD,
        resumeAddClassFlow: false
    });
}

async function getFeed(url) {
    const storyFeed = await client.get(url);
    return storyFeed.data;
}

async function processFeed(url, studentId) {
    const feed = await getFeed(url);

    feedsProcessed++;
    console.log(`found ${feed._items.length} feed items...`);

    for (const item of feed._items) {
        const time = item.time;
        const date = time.split("T")[0];
        const datetime = new Date(time);
        const exifDate = format(datetime, "yyyy:MM:dd HH:mm:ss");

        console.log(exifDate)

        const contents = item.contents;
        const attachments = contents.attachments;

        if (attachments === undefined || attachments.length == 0) {
            // No files to download
            continue;
        }

        // TODO: what if we don't have studentId?
        await createDirectory(Path.resolve(__dirname, IMAGE_DIR, studentId, date));

        for (const attachment of attachments) {
            const url = attachment.path;
            // Extract filename from URL, removing query parameters
            const urlPath = url.split('?')[0]; // Remove query parameters
            const baseFilename = urlPath.substring(urlPath.lastIndexOf("/") + 1);
            const filename = getFilePath(date, baseFilename, studentId);

            await LIMITER();
            downloadFileIfNotExists(url, filename, exifDate);
        }
    }

    console.log("-----------------------------------------------------------------------");
    console.log(`finished processing feed, feedsProcessed = ${feedsProcessed} / ${MAX_FEEDS}`);
    console.log("-----------------------------------------------------------------------");
    if (feedsProcessed < MAX_FEEDS && feed._links && feed._links.prev && feed._links.prev.href) {
        const previousLink = feed._links.prev.href;
        console.log(`found previous link ${previousLink}`);

        try {
            await processFeed(previousLink, studentId);
        } catch (error) {
            console.error("Couldn't get feed", error);
        }
    }
}

async function createDirectory(path) {
    try {
        await mkdirp(path);
        return Promise.resolve();
    } catch (error) {
        return Promise.reject(error);
    }
}

async function downloadFileIfNotExists(url, filePath, exifDate) {
    const exists = await fileExists(filePath);
    console.log(`file ${filePath} exists = ${exists}`);
    if (!exists) {
        try {
            await downloadFile(url, filePath, exifDate);
        } catch (error) {
            console.error("Failed to download file ", url);
        }
    }
}

async function fileExists(filePath) {
    return new Promise((resolve, reject) => {
        try {
            fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
            resolve(true);
        } catch (err) {
            resolve(false);
        }
    });
}

function getFilePath(date, filename, studentId) {
    return Path.resolve(__dirname, IMAGE_DIR, studentId, date, filename);
}

async function downloadFile(url, filePath, exifDate) {
    console.log(`about to download ${filePath}...`)
    const writer = fs.createWriteStream(filePath);

    const response = await client.get(url, {
        responseType: "stream"
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on("finish", async () => {
            console.log(`finished downloading ${filePath}`);

            try {
                await exiftool.write(filePath, { DateTimeOriginal: exifDate });
                console.log(`EXIF capture date added to ${filePath}`);
            } catch (error) {
                console.error(`Error adding EXIF capture date to ${filePath}`, error);
                reject(error);
                return;
            }


            resolve();
        });
        writer.on("error", reject);
    });
}

main();
