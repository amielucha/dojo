import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from 'axios-cookiejar-support';
import fs from "fs";
import Path from "path";
import { mkdirp } from "mkdirp";
import { RateLimit } from "async-sema";
import dotenv from "dotenv";
import { fileURLToPath } from 'url';
dotenv.config();

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
        const date = new Date(time).toISOString().split("T")[0];

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
            const filename = getFilePath(date, url.substring(url.lastIndexOf("/") + 1), studentId);

            await LIMITER();
            downloadFileIfNotExists(url, filename);
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
    return new Promise((resolve, reject) => {
        mkdirp.sync(path);
        resolve();
    });
}

async function downloadFileIfNotExists(url, filePath) {
    const exists = await fileExists(filePath);
    console.log(`file ${filePath} exists = ${exists}`);
    if (!exists) {
        try {
            await downloadFile(url, filePath);
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

async function downloadFile(url, filePath) {
    console.log(`about to download ${filePath}...`)
    const writer = fs.createWriteStream(filePath);

    const response = await client.get(url, {
        responseType: "stream"
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on("finish", () => {
            console.log(`finished downloading ${filePath}`);
            resolve();
        });
        writer.on("error", reject);
    });
}

main();
