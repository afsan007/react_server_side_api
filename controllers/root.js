import jwt from "jsonwebtoken";
import User from "../models/user";
import PDFDocument from "pdfkit";
import _ from "lodash";
import moment from "moment";
import parser from "ua-parser-js";
var Redis = require("ioredis");
var redis = new Redis({
	retryStrategy: function(times) {
		var delay = Math.min(times * 50, 2000);
		return delay;
	}
});
const Day = moment().format("YYYY/MM/D");

const RootController = {};
const PAGE_LIMIT_COUNT = 10;
const admins = [
	{ id: 1, name: "Kurtis Weissnat" },
	{ id: 2, name: "Nicholas Runolfsdottir" },
	{ id: 3, name: "Gelann Reichert" },
	{ id: 4, name: "Moriah Stanton" },
	{ id: 5, name: "Rey Padberg" }
];

RootController.rootPage = (req, res) => {
	let adminContent = `
        <div>
        You don't appear to be logged in.  You can log in by visiting
        <a href="/auth/google">the Authentication Route</a>. You could
        also look at details about yourself at <a href="/api/current_user">the Current User route</a>
        </div>
    `;
	if (req.user) {
		adminContent = `
        <div>
            You appear to be logged in, so you can visit <a href="/admins">the Admins route</a>
            or you can
            <form action="/logout" method="get">
                <input type="hidden" name="_csrf" value="${req.csrfToken()}"></input>
                <button type="submit">Logout</button>
            </form>
        </div>
        `;
	}
	res.send(`
        <div>
        <h4>Hi!  Welcome to the React SSR API</h4>
        <div>
        <form action="/userslistpdf" method="get">
        <button>usersListPdf</button>
        </form>
            You can see <a href="/users">the Users route</a>
        </div>
        ${adminContent}
        </div>
    `);
};
RootController.usersList = (req, res, next) => {
	let page = +req.query.page;
	let totalUsers;
	let search = {
		$or: [{ name: { $regex: /sajj/ } }, { email: { $regex: /has/ } }]
	};
	if (page < 1) {
		page = 1;
	}
	User.find(search)
		.countDocuments()
		.then(usersCount => {
			totalUsers = usersCount;
			if (page > Math.ceil(totalUsers / PAGE_LIMIT_COUNT)) {
				page = Math.ceil(totalUsers / PAGE_LIMIT_COUNT);
			}
			return User.find(search)
				.skip((page - 1) * PAGE_LIMIT_COUNT)
				.limit(PAGE_LIMIT_COUNT);
		})
		.then(async users => {
			if (!users) {
				return "no user has been registered yet";
			}

			let Users = users.map(
				({ _id, name, email, isVerified, createdAt, lastLogin }) =>
					//SOLVED: check for user online or offline by redis use users id(filterUsers)
					redis.sismember("online:users", _id.toString()).then(res => {
						let status = res === 1 ? true : false;
						return { _id, name, email, isVerified, status, createdAt, lastLogin };
					})
			);
			Users = await Promise.all(Users);

			let hasNextPage = PAGE_LIMIT_COUNT * page < totalUsers;
			let hasPreviousPage = page > 1;
			let lastPage = Math.ceil(totalUsers / PAGE_LIMIT_COUNT);

			res.send({
				Users,
				totalUsers,
				hasNextPage,
				hasPreviousPage,
				lastPage,
				currentPage: page
			});
		})
		.catch(e => {
			next(new Error(e));
		});
};
RootController.logIn = (req, res) => {
	res.send(`
    <html>
      <body>
        <a href="auth/google">Login via Google</a>
      </body>
    </html>`);
};
RootController.admins = (req, res) => {
	res.send(admins);
};
RootController.redirectToRoot = (req, res) => {
	res.redirect("/");
};
RootController.logOut = async (req, res) => {
	/*
        find user bucket in online:Users container 
        -check the value of bucket length 
            -length = 0 | it can't be happen 
            -length = 1 | delete user from online:Users container + decrement online:users:count
            -length > 1 | grab the user current browser value from bucket
                    delete the user browser from the value
            At the End stringify & store new reply on userID's bucket in online:Users 
    */
	let { id } = req.user;
	let { browser, os } = parser(req.headers["user-agent"]);
	let browserContainer =
		browser.name + browser.major + ":" + os.name + os.version;

	await redis.hget("online:Users", id, (err, reply) => {
		if (reply) {
			reply = JSON.parse(reply);
			delete reply[browserContainer];
			if (Object.keys(reply).length === 0) {
				redis.hdel("online:Users", id, (err, result) => {
					redis.decr("online:users:count");
				});
			} else {
				reply = JSON.stringify(reply);
				redis.hset("online:Users", id, reply);
			}
		}
	});

	await req.logout();
	res.redirect("/");
};
RootController.emailVerification = (req, res, next) => {
	const { token } = req.query;
	// Check to see token is valid with specified email
	jwt.verify(
		token,
		"afsan|user|emailVerify|007",
		{ subject: "emailVerification" },
		(err, decoded) => {
			// Check to see can find email
			if (err) {
				err.name === "TokenExpiredError"
					? res.status(500).send("request expired please try again")
					: res.send({ err });
			}
			User.findOneAndUpdate(
				{ email: decoded.email },
				{ $set: { isVerified: true } },
				{ new: false },
				(err, user) => {
					if (err) next(new Error("can't find Email try again"));
					if (!user.isVerified) redis.hincrby("total:Verified:UserList", Day, 1);
					res.redirect("/");
				}
			);
		}
	);
};
RootController.resetPassword = (req, res, next) => {
	const { token } = req.query;
	jwt.verify(
		token,
		"afsan|user|resetPassword|007",
		{ subject: "resetPassword" },
		(err, decoded) => {
			if (err) {
				if (err.name === "TokenExpiredError") {
					return res.status(500).send("request expired please try again");
				} else {
					return res.send({ err });
				}
			}
			res.send({ email: decoded.email });
		}
	);
};
RootController.printUsers = (req, res, next) => {
	res.setHeader("Content-Type", "application/pdf");
	res.setHeader("Content-Disposition", 'inline;filename="usersList"');
	User.find()
		.then(async users => {
			if (!users) {
				return "no user has been registered yet";
			}
			const pdfDoc = new PDFDocument();
			res.setHeader("Content-Type", "application/pdf");
			let invoiceName = "userslist";
			res.setHeader(
				"Content-Disposition",
				'inline; filename="' + invoiceName + '"'
			);
			pdfDoc.pipe(res);

			pdfDoc.fontSize(26).text("Invoice", {
				underline: true
			});
			pdfDoc.text("-----------------------");
			users = users.map(user => {
				return { name: user.name, email: user.email };
			});
			users.forEach((user, i) => {
				pdfDoc.text(i + ")" + user.email + "---" + user.name);
			});
			pdfDoc.text("---");
			pdfDoc.end();
		})
		.catch(e => {
			next(new Error(e));
		});
};

export default RootController;
