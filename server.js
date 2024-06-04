const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Use an interval to send updates
    const intervalId = setInterval(() => {
        res.write('data: heartbeat\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(intervalId);
    });
});

app.post('/login', async (req, res) => {
    const { name, password } = req.body;
    console.log('Received form data:', name, password);

    try {
        // Start the data extraction process
        automateGLSLogin(name, password, res);

        // Redirect to the result page
        res.redirect('/result');
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('An error occurred during the login process.');
    }
});

app.get('/result', (req, res) => {
    res.render('result', { data: [] });
});

async function automateGLSLogin(username, password, res) {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null
    });
    const page = await browser.newPage();

    try {
        console.log('Navigating to the login page...');
        await page.goto('https://atlas.gls-spain.es/Account/Login?ReturnUrl=%2F&Error=Sesi%C3%B3n%20expirada');

        console.log('Filling the login form...');
        await page.type('#username', username);
        await page.type('input[name="password"]', password);

        console.log('Submitting the login form...');
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click('.btn.btn-primary')
        ]);

        console.log('Successfully logged in.');
        await page.goto('https://atlas.gls-spain.es/customer/index');

        await page.waitForSelector('body');
        await waitForSpinnerToDisappear(page);

        await selectRecordsPerPage(page, 1000);

        await page.waitForSelector('a[href="#tab_Web"]', { timeout: 60000 });
        await page.evaluate(() => {
            document.querySelector('a[href="#tab_Web"]').click();
        });

        await waitForSpinnerToDisappear(page);

        const data = await processLogins(page, res);
        return data;

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await browser.close();
    }
}

async function selectRecordsPerPage(page, value) {
    try {
        console.log(`Setting records per page to ${value}...`);
        await page.evaluate((value) => {
            const select = document.querySelector('#optionPaginator');
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        await waitForSpinnerToDisappear(page);
    } catch (error) {
        console.error('Error selecting records per page:', error);
    }
}

async function processLogins(page, res) {
    try {
        const totalRecords = await page.evaluate(() => {
            const totalElement = document.querySelector('span[data-bind="text: my.vm.recordsTotal"]');
            return totalElement ? parseInt(totalElement.textContent, 10) : 0;
        });

        console.log(`Total records: ${totalRecords}`);
        const extractedData = [];

        for (let rowIndex = 0; rowIndex < totalRecords; rowIndex++) {
            try {
                let rows = await page.$$('#table-customer-simple tbody tr');

                while (rowIndex >= rows.length) {
                    await page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight);
                    });
                    await delay(2000);
                    rows = await page.$$('#table-customer-simple tbody tr');
                }

                if (rows[rowIndex]) {
                    const data = await interactWithRow(page, rowIndex);
                    console.log(`Extracted data from row ${rowIndex}:`, data);
                    extractedData.push(data);

                    // Send data to client
                    res.write(`data: ${JSON.stringify(data)}\n\n`);
                } else {
                    console.error(`Row ${rowIndex} does not exist anymore.`);
                    break;
                }
            } catch (error) {
                console.error(`Error processing row ${rowIndex}:`, error);
                await delay(1000);
            }
        }
        res.write('data: [END]\n\n'); // Signal end of data
        return extractedData;
    } catch (error) {
        console.error('Error:', error);
    }
}

async function interactWithRow(page, rowIndex) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(rowIndex);
            await page.waitForSelector(`tr[data-toggle="${rowIndex}"]`, { timeout: 60000 });
            await clickRowByDataToggle(page, rowIndex);
            await waitForSpinnerToDisappear(page);
            const data = await extractData(page, rowIndex);
            console.log(`Row ${rowIndex} data:`, data);
            await page.evaluate(() => {
                const closeButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '×');
                if (closeButton) closeButton.click();
            });
            await waitForSpinnerToDisappear(page);
            return data;
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            console.warn(`Retrying interaction with row due to error: ${error.message}`);
            await delay(1000);
        }
    }
}

async function clickRowByDataToggle(page, dataToggleValue) {
    try {
        await page.evaluate((dataToggleValue) => {
            const row = document.querySelector(`tr[data-toggle="${dataToggleValue}"]`);
            if (row) {
                row.click();
            } else {
                throw new Error(`Row with data-toggle="${dataToggleValue}" not found`);
            }
        }, dataToggleValue);
        console.log(`Clicked row with data-toggle="${dataToggleValue}"`);
    } catch (error) {
        console.error(`Error clicking row with data-toggle="${dataToggleValue}":`, error);
    }
}

async function extractData(page, rowIndex) {
    try {
        const rowSelector = `tr[data-toggle="${rowIndex}"]`;
        await page.waitForSelector(rowSelector, { timeout: 60000 });

        const clientCode = await page.evaluate((rowSelector) => {
            const row = document.querySelector(rowSelector);
            return row.querySelector('td:nth-child(2) span').textContent.trim();
        }, rowSelector);

        await waitForSpinnerToDisappear(page);
        await page.evaluate(() => {
            setTimeout(() => {
                const buttons = document.querySelectorAll('.btn.btn-default');
                buttons.forEach(button => {
                    if (button.textContent.trim() === 'Editar') {
                        button.click();
                    }
                });
            });
        });

        await page.waitForSelector('input[data-bind^="value: my.vmWeb().newLogin().uid"][readonly]', { timeout: 60000 });

        const uid = await page.evaluate(() => {
            const uidInput = document.querySelector('input[data-bind^="value: my.vmWeb().newLogin().uid"][readonly]');
            return uidInput ? uidInput.value : null;
        });

        await waitForSpinnerToDisappear(page);
        await page.evaluate(() => {
            setTimeout(() => {
                const buttons = document.querySelectorAll('button');
                buttons.forEach(button => {
                    if (button.textContent.trim() === '×') {
                        button.click();
                    }
                });
            });
        });
        await waitForSpinnerToDisappear(page);

        return { clientCode, uid };

    } catch (error) {
        console.error('Error extracting data:', error);
    }
}

async function waitForSpinnerToDisappear(page) {
    try {
        await page.waitForFunction(() => {
            const spinner = document.querySelector('.spinner-overlay');
            return !spinner || window.getComputedStyle(spinner).display === 'none';
        }, { timeout: 60000 });
    } catch (error) {
        console.error('Spinner did not disappear:', error);
    }
}

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time);
    });
}

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
