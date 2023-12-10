const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const mysql = require("mysql");
const { checkLogin, recordAttendance } = require("./loginFunctions");
const {
  checkDOB,
  checkAvailability,
  getCurrentDate,
} = require("./globalFunctions");
const cron = require("node-cron");
const fs = require("fs");

const app = express();
const port = 8080;

const corsOptions = {
  origin: "http://localhost:5173",
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  optionsSuccessStatus: 200,
};
const connection = mysql.createConnection({
  host: "35.193.177.25",
  user: "root",
  password: "root123",
  database: "childcare",
});

connection.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL:", err);
    return;
  }
  console.log("Connected to MySQL");
});

app.use(cors());

app.use(bodyParser.json());

const checkUserRole = (roles) => {
  return async (req, res, next) => {
    let email = req.headers.email;
    let role = req.headers.role;
    if (!email) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: User not authenticated",
      });
    }

    try {
      if (roles.includes(role)) {
        next();
      } else {
        res.status(403).json({
          success: false,
          message: "Forbidden: Insufficient permissions",
        });
      }
    } catch (error) {
      res
        .status(500)
        .json({ success: false, message: "Internal Server Error" });
    }
  };
};

app.post("/check_admin_login", (req, res) => {
  const query =
    "SELECT * FROM admin_user_creds WHERE userName = ? AND password = ?";

  checkLogin(connection, query, req, res);
});

app.post("/check_login", (req, res) => {
  let query =
    "SELECT * FROM user_data WHERE userName = ? AND password = ? AND role=?";

  checkLogin(connection, query, req, res);
});

app.post("/enroll_child", checkUserRole(["Admin"]), (req, res) => {
  let data = req.body;

  let ageGroup = checkDOB(data.dob);

  checkAvailability(ageGroup, connection).then((isAvailable) => {
    if (!isAvailable) {
      res.json({
        success: false,
        message: "Capacity full",
      });

      return;
    }

    if (data.waitlistID) {
      const query = "DELETE FROM waitlist WHERE ID=?";

      connection.query(query, [data.waitlistID], (error, results) => {
        if (error) {
          console.error("Error executing query: " + error.stack);
          res.status(500).json({ error: "Internal Server Error" });
          return;
        }
      });
    }

    let query_child =
      "INSERT INTO Child(FirstName, LastName, dob, Allergies,Agegroup) VALUES (?, ?, ?, ?,?)";

    connection.query(
      query_child,
      [data.FirstName, data.LastName, data.dob, data.Allergies, ageGroup],
      (err, childResults) => {
        if (err) {
          console.error("Error executing child query:", err);
          return;
        }

        let query_parent =
          "INSERT INTO parent(ParentID,ChildID, ParentFirstName, ParentLastName, PhoneNumber, Address,email) VALUES (?,?, ?, ?, ?, ?,?)";

        connection.query(
          query_parent,
          [
            childResults.insertId,
            childResults.insertId,
            data.ParentFirstName,
            data.ParentLastName,
            data.PhoneNumber,
            data.Address,
            data.email,
          ],
          (err, parentResults) => {
            if (err) {
              console.error("Error executing parent query:", err);
              return;
            }

            let query_enrollment =
              "INSERT INTO Enrollment(EnrollmentID,ChildID,consentForm) VALUES (?,?,?)";

            connection.query(
              query_enrollment,
              [childResults.insertId, childResults.insertId, data.consentForm],
              (err, enrollmentResults) => {
                if (err) {
                  console.error("Error executing enrollment query:", err);
                  return;
                }

                res.json({
                  success: true,
                  message: "Data inserted successfully",
                });
              }
            );
          }
        );
      }
    );
  });
});

app.get(
  "/get_enrolled_students",
  checkUserRole(["Admin", "Parent"]),
  (req, res) => {
    const email = req.query.email;

    let query = `
   SELECT
      E.EnrollmentID,
      DATE_FORMAT(E.EnrollmentDate, '%m-%d-%Y') as enrollmentDate,
      C.ChildID,
      C.FirstName AS ChildFirstName,
      C.LastName AS ChildLastName,
      C.AgeGroup,
      DATE_FORMAT(C.dob, '%m-%d-%Y') AS ChildDateOfBirth,
      C.Allergies,
      P.ParentID,
      P.ParentFirstName,
      P.ParentLastName,
      P.PhoneNumber,
      P.Address,
      P.invite
    FROM Enrollment E
    JOIN Child C ON E.ChildID = C.ChildID
    JOIN parent P ON C.ChildID = P.ChildID
  `;

    if (email) {
      query += ` WHERE P.email = '${email}'`;
    }

    query += ` ORDER BY E.EnrollmentDate DESC`;
    connection.query(query, (error, results) => {
      if (error) {
        console.error("Error executing query: " + error.stack);
        res.status(500).json({ error: "Internal Server Error" });
        return;
      }

      res.json(email ? results[0] : results);
    });
  }
);

app.get("/get_hired_staff", checkUserRole(["Admin"]), (req, res) => {
  const query =
    "SELECT ID, FirstName,email, LastName, DATE_FORMAT(DOB, '%m-%d-%Y') AS DOB, Address, PhoneNumber, HourlySalary, DATE_FORMAT(HireDate, '%m-%d-%Y') AS HireDate,invite, COALESCE(JSON_UNQUOTE(JSON_EXTRACT(assigned, '$')), JSON_ARRAY()) AS assigned FROM staff ORDER BY HireDate DESC";

  connection.query(query, (error, results) => {
    if (error) {
      console.error("Error executing query: " + error.stack);
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }

    // Parse the assigned column for each row
    const parsedResults = results.map((row) => {
      row.assigned = JSON.parse(row.assigned);
      return row;
    });

    res.json(parsedResults);
  });
});

app.post("/withdraw_child", checkUserRole(["Admin"]), (req, res) => {
  const enrollmentID = req.body.enrollmentID.toString();
  const isWaitlist = req.body.isWaitlist;

  if (isWaitlist) {
    const query = "DELETE FROM waitlist WHERE ID=?";

    connection.query(query, [enrollmentID], (error, results) => {
      if (error) {
        console.error("Error executing query: " + error.stack);
        res.status(500).json({ error: "Internal Server Error" });
        return;
      } else {
        res.json({ success: true, message: "Child removed successfully" });
      }
    });
  } else {
    const query = "DELETE FROM Child WHERE ChildID = ?";
    const query1 = "DELETE FROM parent WHERE ParentID = ?";
    const query2 = "DELETE FROM Enrollment WHERE EnrollmentID = ?";

    connection.query(query2, [enrollmentID], (error, results) => {
      if (error) {
        console.error("Error executing query: " + error.stack);
        res.status(500).json({ error: "Internal Server Error" });
        return;
      }
      connection.query(query1, [enrollmentID], (error1, results) => {
        if (error1) {
          console.error("Error executing query: " + error.stack);
          res.status(500).json({ error: "Internal Server Error" });
          return;
        }
      });
      connection.query(query, [enrollmentID], (error1, results) => {
        if (error1) {
          console.error("Error executing query: " + error.stack);
          res.status(500).json({ error: "Internal Server Error" });
          return;
        }

        res.json({ success: true, message: "Child removed successfully" });
      });
    });
  }
});

app.post("/withdraw_staff", checkUserRole(["Admin"]), (req, res) => {
  const staffID = req.body.ID.toString();
  const query = "DELETE FROM staff WHERE ID=?";
  connection.query(query, [staffID], (error, results) => {
    if (error) {
      console.error("Error executing query: " + error.stack);
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    res.json({ success: true, message: "Staff member removed successfully" });
  });
});

app.get("/get_classroom_enrollments", checkUserRole(["Admin"]), (req, res) => {
  const query = `SELECT 
    CR.ClassroomID, 
    CR.ClassName, 
    CR.Capacity, 
    CR.fees,
    COUNT(CH.AgeGroup) AS Occupied 
FROM 
    classroom CR 
LEFT JOIN 
    Child CH ON CR.ClassName = CH.AgeGroup 
GROUP BY 
    CR.ClassroomID`;

  connection.query(query, (error, results) => {
    if (error) {
      console.error("Error executing query: " + error.stack);
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    res.json(results);
  });
});

app.post("/enroll_child_waitlist", checkUserRole(["Admin"]), (req, res) => {
  const data = req.body;
  const ageGroup = checkDOB(data.dob);
  data["AgeGroup"] = ageGroup;

  const waitlistQuery =
    "INSERT INTO waitlist (FirstName, LastName, ParentFirstName, ParentLastName, DOB, AgeGroup, Address, Allergies, PhoneNumber) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

  connection.query(
    waitlistQuery,
    [
      data.FirstName,
      data.LastName,
      data.ParentFirstName,
      data.ParentLastName,
      data.dob,
      data.AgeGroup,
      data.Address,
      data.Allergies,
      data.PhoneNumber,
    ],
    (error, results) => {
      if (error) {
        console.error("Error executing waitlist query:", error.stack);
        return res.status(500).json({
          success: false,
          message: "Error inserting into Waitlist table",
        });
      }

      res.json({
        success: true,
        message: "Data inserted into Waitlist successfully",
      });
    }
  );
});

app.get("/get_waitlist_students", checkUserRole(["Admin"]), (req, res) => {
  connection.query(
    `SELECT 
    DATE_FORMAT(DOB, '%m-%d-%Y') AS ChildDateOfBirth,
    DATE_FORMAT(enrollmentDate, '%m-%d-%Y') AS date,
    W.* 
  FROM waitlist W`,
    (error, results) => {
      if (error) {
        console.error("Error executing waitlist query:", error.stack);
        return res.status(500).json({
          success: false,
          message: "Error inserting into Waitlist table",
        });
      }

      res.json(results);
    }
  );
});

app.post("/update_staff", checkUserRole(["Admin"]), (req, res) => {
  const { id, assigned } = req.body;

  connection.query(
    "UPDATE staff SET assigned = ? WHERE id = ?",
    [JSON.stringify(assigned), id],
    (error, results) => {
      if (error) {
        console.error("Error updating staff:", error.stack);
        return res.status(500).json({
          success: false,
          message: "Error updating staff assigned column",
        });
      }

      res.json({
        success: true,
        message: "Staff assigned column updated successfully",
      });
    }
  );
});

app.get(
  "/get_available_classrom_spots",
  checkUserRole(["Admin"]),
  (req, res) => {
    let assigned = [];
    let countDict = {};
    let childAvialable = {
      Infant: true,
      Toddler: true,
      Twaddler: true,
      "3 Years Old": true,
      "4 Years Old": true,
    };

    connection.query("Select * from staff", (err, staffData) => {
      if (err) {
        console.error("Error updating staff:", err.stack);
        return res.status(500).json({
          success: false,
          message: "Error updating staff assigned column",
        });
      }
      staffData.map((item, index) => {
        const parsedAssign = JSON.parse(item.assigned);
        if (Array.isArray(parsedAssign)) {
          assigned = [...assigned, ...parsedAssign];
        }
      });

      assigned.forEach((str) => {
        if (typeof str == "string") {
          if (!countDict.hasOwnProperty(str)) {
            countDict[str] = 1;
          } else {
            countDict[str]++;
          }
        }
      });

      connection.query(
        "SELECT AgeGroup, COUNT(*) AS Count FROM Child GROUP BY AgeGroup",
        (err, ageGroupCounts) => {
          if (err) {
            console.error("Error fetching child data:", err.stack);
            return res.status(500).json({
              success: false,
              message: "Error fetching child data",
            });
          }

          ageGroupCounts.forEach((ageGroupCount) => {
            const { AgeGroup, Count } = ageGroupCount;
            switch (AgeGroup) {
              case "Infant":
                childAvialable.Infant = Count < 5;
                break;
              case "Toddler":
                childAvialable.Toddler = Count < 6;
                break;
              case "Twaddler":
                childAvialable.Twaddler = Count < 8;
                break;
              case "3 Years Old":
                childAvialable["3 Years Old"] = Count < 9;
                break;
              case "4 Years Old":
                childAvialable["4 Years Old"] = Count < 10;
                break;
            }
          });
          Object.keys(childAvialable).forEach((key) => {
            if (childAvialable[key]) {
              childAvialable[key] = countDict[key] != 1 && countDict[key] != 2;
            } else {
              childAvialable[key] = countDict[key] < 2;
            }
          });

          res.json(childAvialable);
        }
      );
    });
  }
);

// Schedule the task to run every Monday at 12:00 AM
cron.schedule("0 0 * * 1", async () => {
  calculateFees();
});

function calculateWeeklyFee(startDate, endDate, fees, totalPaid = 0) {
  const millisecondsPerWeek = 7 * 24 * 60 * 60 * 1000;

  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);

  // Calculate the difference in milliseconds
  const timeDifference = endDateObj - startDateObj;

  // Calculate the number of weeks
  const numberOfWeeks = Math.floor(timeDifference / millisecondsPerWeek);

  const totalFee =
    (numberOfWeeks +
      (startDateObj.getDay() !== 1 &&
      startDateObj.getDay() !== 0 &&
      startDateObj.getDay() !== 6
        ? 1
        : 0)) *
    fees;

  return totalFee - totalPaid;
}

app.get(
  "/get_student_ledger",
  checkUserRole(["Admin", "Parent"]),
  (req, res) => {
    getStudentLedger(req, res);
  }
);

async function getStudentLedger(req, res) {
  try {
    let childId = req.query.id;
    let query = `SELECT
          Child.ChildID,
          Child.FirstName AS ChildFirstName,
          Child.LastName AS ChildLastName,
          parent.ParentFirstName AS ParentFirstName,
          parent.ParentLastName AS ParentLastName,
          parent.PhoneNumber AS PhoneNumber,
          ledger.balance,
          ledger.totalPaid,
          DATE_FORMAT(ledger.GeneratedDate, '%m-%d-%Y') AS GeneratedDate
      FROM
          Child
      JOIN
          parent ON Child.ChildID = parent.ChildID
      LEFT JOIN
          led AS ledger ON Child.ChildID = ledger.ChildID
    `;

    if (childId) {
      query += ` WHERE Child.ChildID = ?`;
    }
    const data = await queryAsync(query, [childId]);
    res.json(data);
  } catch (error) {
    console.error("Error:", error);
  }
}

async function calculateFees() {
  try {
    //Get child enrollment data
    const children = await queryAsync(`
    SELECT 
     Child.*,
     DATE_FORMAT(Enrollment.EnrollmentDate, '%m-%d-%Y') AS enrollmentDate,
     studentledger.ID,
     studentledger.totalPaid,
     studentledger.balance,
     DATE_FORMAT(studentledger.GeneratedDate, '%m-%d-%Y') AS GeneratedDate
    FROM Child
    JOIN Enrollment ON Child.ChildID = Enrollment.ChildID
    LEFT JOIN studentledger ON Child.ChildID = studentledger.ChildID;
  `);

    //Get Fee structure from classroom table
    const classroom = await queryAsync(`Select * from classroom`);
    const feeStucture = {};
    const currentDate = new Date();
    let data = [];

    for (const classData of classroom) {
      feeStucture[classData.ClassName] = classData.fees;
    }

    //Here the amount for the weeks are calculated
    for (const child of children) {
      const fees = feeStucture[child.AgeGroup];

      const amount = calculateWeeklyFee(
        child.enrollmentDate,
        currentDate,
        fees,
        child.totalPaid
      );

      data.push({
        ChildID: child.childID,
        balance: amount,
        GeneratedDate: `${currentDate.getFullYear()}-${
          currentDate.getMonth() + 1
        }-${currentDate.getDate()}`,
      });
    }

    const query = `
      INSERT INTO led (ChildID, balance, GeneratedDate)
      VALUES
        ${data
          .map(
            ({ ChildID, balance, GeneratedDate }) =>
              `(${ChildID}, ${balance}, '${GeneratedDate}')`
          )
          .join(",\n")}
          ON DUPLICATE KEY UPDATE
          balance = VALUES(balance),
          GeneratedDate = VALUES(GeneratedDate)
    `;

    await queryAsync(query);
  } catch (error) {
    console.error("Error:", error);
  }
}

function queryAsync(sql, values) {
  return new Promise((resolve, reject) => {
    connection.query(sql, values, (error, results) => {
      if (error) {
        reject(error);
      } else {
        resolve(results);
      }
    });
  });
}

app.post("/hire_staff", checkUserRole(["Admin"]), (req, res) => {
  const values = req.body;
  let query = `INSERT INTO staff(FirstName,LastName,DOB,Address,PhoneNumber,HourlySalary,assigned,email) VALUES(?, ?, ?, ?, ?, ?, ?,?)`;
  connection.query(
    query,
    [
      values.FirstName,
      values.LastName,
      values.dob,
      values.Address,
      values.PhoneNumber,
      values.HourlySalary,
      JSON.stringify(values.assigned),
      values.email,
    ],
    (error, results) => {
      if (error) {
        console.error("Error executing query: " + error.stack);
        res.status(500).json({ error: "Internal Server Error" });
        return;
      } else {
        res.json({
          success: true,
          message: "Data inserted successfully",
        });
      }
    }
  );
});

async function checkIfInvited(values) {
  const quer =
    values.roles == "Teacher"
      ? "SELECT * FROM staff WHERE email = ? AND invite = 1"
      : "SELECT * FROM parent WHERE email = ? AND invite = 1";
  const staffResult = await queryAsync(quer, [values.email]);
  return staffResult.length;
}

app.post("/create_account", (req, res) => {
  let values = req.body;
  let re = checkIfInvited(values);

  const quer =
    values.roles == "Teacher"
      ? "SELECT * FROM staff WHERE email = ? AND invite = 1"
      : "SELECT * FROM parent WHERE email = ? AND invite = 1";

  connection.query(quer, [values.email], (er, re) => {
    if (!re.length) {
      res.json({
        success: false,
        message: "Your are not invited yet",
      });
      return;
    }

    let details = re[0];

    let query =
      "INSERT INTO user_data(userName,firstName,lastName,password,email,phoneNumber,role) VALUES(?,?,?,?,?,?,?)";

    connection.query(
      query,
      [
        values.userName,
        values.roles == "Teacher" ? details.FirstName : details.ParentFirstName,
        values.roles == "Teacher" ? details.LastName : details.ParentLastName,
        values.password,
        details.email,
        details.PhoneNumber,
        values.roles,
      ],
      (error, results) => {
        if (error) {
          console.error("Error executing query: " + error.stack);
          res.status(500).json({ error: "Internal Server Error" });
          return;
        } else {
          res.json({
            success: true,
            message: "Account Created",
          });
        }
      }
    );
  });
});

app.post("/create_facility_account", (req, res) => {
  let values = req.body;
  let query =
    "INSERT INTO user_data(userName,firstName,lastName,password,email,phoneNumber,role) VALUES(?,?,?,?,?,?,?)";

  connection.query(
    query,
    [
      values.userName,
      values.FirstName,
      values.LastName,
      values.password,
      values.email,
      values.PhoneNumber,
      values.roles,
    ],
    (error, results) => {
      if (error) {
        console.error("Error executing query: " + error.stack);
        res.status(500).json({ error: "Internal Server Error" });
        return;
      } else {
        let facilityQuery =
          "INSERT INTO FACILITY(name,address,phoneNumber,licenseNumber,userId) VALUES(?,?,?,?,?)";
        connection.query(
          facilityQuery,
          [
            values.facilityName,
            values.facilityAddress,
            values.facilityPhoneNumber,
            values.licenseNumber,
            results.insertId,
          ],
          (err, resul) => {
            console.log(err);
            res.json({
              success: true,
              message: "Account Created",
            });
          }
        );
      }
    }
  );
});

app.post("/sign_out", checkUserRole(["Teacher"]), (req, res) => {
  let values = req.body;
  recordAttendance(values, connection, res, true);
});

app.get("/get_staff_attendance", (req, res) => {
  let query = `
 SELECT
  s.ID AS StaffID,
  s.FirstName,
  s.LastName,
  s.HourlySalary,
  WEEK(CURRENT_DATE()) AS WeekNumber,
  DATE_FORMAT(CURRENT_DATE() - INTERVAL WEEKDAY(CURRENT_DATE()) DAY, '%m-%d-%Y') AS FirstDateOfWeek,
  DATE_FORMAT(CURRENT_DATE() + INTERVAL (4 - WEEKDAY(CURRENT_DATE())) DAY, '%m-%d-%Y') AS LastDateOfWeek,
  COALESCE((SUM(TIMESTAMPDIFF(MINUTE, sa.SignInTime, COALESCE(sa.SignOutTime, NOW()))) / 60), 0) AS HoursWorked,
  FORMAT(COALESCE((SUM(TIMESTAMPDIFF(MINUTE, sa.SignInTime, COALESCE(sa.SignOutTime, NOW()))) / 60) * s.HourlySalary, 0), 2) AS AmountEarned
FROM staff s
LEFT JOIN StaffAttendance sa 
  ON s.ID = sa.StaffID
  AND sa.SignInTime >= CURRENT_DATE() - INTERVAL WEEKDAY(CURRENT_DATE()) DAY
  AND sa.SignInTime < CURRENT_DATE() + INTERVAL (5 - WEEKDAY(CURRENT_DATE())) DAY
GROUP BY s.ID;
`;

  connection.query(query, (err, result) => {
    if (err) {
      console.error("Error executing query: " + err.stack);
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
    res.json({
      success: true,
      data: result,
    });
  });
});

app.get("/get_staff_attendance_by_id/:id", (req, res) => {
  let email = req.params.id;
  let query = `
  SELECT
  sa.StaffID,
  s.FirstName,
  s.LastName,
  s.HourlySalary,
  WEEK(sa.SignInTime) AS WeekNumber,
  DATE_FORMAT(MIN(DATE(sa.SignInTime - INTERVAL WEEKDAY(sa.SignInTime) DAY)), '%m-%d-%Y') AS FirstDateOfWeek,
  DATE_FORMAT(MAX(DATE(sa.SignInTime - INTERVAL WEEKDAY(sa.SignInTime) - 4 DAY)), '%m-%d-%Y') AS LastDateOfWeek,
  (SUM(TIMESTAMPDIFF(MINUTE, sa.SignInTime, COALESCE(sa.SignOutTime, NOW()))) / 60) AS HoursWorked,
 FORMAT((SUM(TIMESTAMPDIFF(MINUTE, sa.SignInTime, COALESCE(sa.SignOutTime, NOW()))) / 60) * s.HourlySalary, 2) AS AmountEarned 
 FROM StaffAttendance sa
JOIN staff s ON sa.StaffID = s.ID
WHERE s.email=?
GROUP BY sa.StaffID,WeekNumber
`;

  connection.query(query, [email], (err, result) => {
    res.json({
      success: true,
      data: result,
    });
  });
});

app.get("/get_staff_personal_information/:id", (req, res) => {
  let values = req.params.id;
  let query = `SELECT
   staff.*,
   DATE_FORMAT(DOB,'%m-%d-%Y') as DOB,
   DATE_FORMAT(HireDate,'%m-%d-%Y') as HireDate
   FROM staff WHERE email=?`;
  connection.query(query, [values], (error, results) => {
    let dat = results[0];
    dat.assigned = JSON.parse(dat.assigned);
    res.json(dat);
  });
});

app.get("/get_assigned_enrolled_children", (req, res) => {
  let email = req.headers.email;

  let query = `Select * from staff where email=?`;

  connection.query(query, [email], (err, results) => {
    let assigned = JSON.parse(results[0].assigned);

    let query1 = `
   SELECT
      E.EnrollmentID,
      DATE_FORMAT(E.EnrollmentDate, '%m-%d-%Y') as enrollmentDate,
      C.ChildID,
      C.FirstName AS ChildFirstName,
      C.LastName AS ChildLastName,
      C.AgeGroup,
      DATE_FORMAT(C.dob, '%m-%d-%Y')AS ChildDateOfBirth,
      C.Allergies,
      P.ParentID,
      P.ParentFirstName,
      P.ParentLastName,
      P.PhoneNumber,
      P.Address,
      SA.SignInTime,
      SA.SignOutTime
    FROM Enrollment E
    JOIN Child C ON E.ChildID = C.ChildID
    JOIN parent P ON C.ChildID = P.ChildID
    LEFT JOIN studentAttendance SA ON C.ChildID = SA.childID AND DATE(SA.SignInTime) = CURRENT_DATE
    ORDER BY E.EnrollmentDate DESC`;
    connection.query(query1, (req, enrollData) => {
      let data = [];
      for (const child of enrollData) {
        if (assigned.includes(child.AgeGroup)) {
          data.push(child);
        }
      }
      res.json(data);
    });
  });
});

app.post("/mark_child_login", (req, res) => {
  let id = req.body.id;

  const currentDate = new Date();

  connection.query(
    `INSERT INTO studentAttendance (childID, SignInTime)
            VALUES (?, ?)`,
    [id, currentDate],
    (er, result) => {
      res.json({
        sucess: true,
        message: "student checked in",
      });
    }
  );
});

app.post("/mark_child_logout", (req, res) => {
  let id = req.body.id;

  const currentDate = new Date();
  console.log(currentDate);

  connection.query(
    `UPDATE studentAttendance set SignOutTime = ?
              WHERE childID = ? AND DATE(SignInTime) = ?
              AND SignOutTime IS NULL`,
    [currentDate, id, currentDate.toISOString().split("T")[0]],
    (req, result) => {
      res.json({
        success: true,
        message: "Student Checked out",
      });
    }
  );
});

app.get("/get_child_attendance", (req, res) => {
  let queryDate = req.query.date;
  let childID = req.query.childID;
  let ageGroup = req.query.ageGroup;
  let isPresent = req.query.isPresent;

  let query = "";
  let queryParams = [];

  if (isPresent === "true") {
    // Query for present students
    query = `SELECT c.FirstName, c.LastName, c.ageGroup, c.childID,
                    DATE_FORMAT(sa.SignInTime, '%Y-%m-%d') AS date,
                    DATE_FORMAT(sa.SignInTime, '%h:%i %p') AS SignInTime,
                    DATE_FORMAT(sa.SignOutTime, '%h:%i %p') AS SignOutTime
             FROM Child c
             JOIN studentAttendance sa ON c.childID = sa.childID`;

    if (queryDate) {
      query += " WHERE DATE(sa.SignInTime) = ?";
      queryParams.push(queryDate);
    }
  } else {
    // Query for absent students
    let currentDate = getCurrentDate();
    currentDate = currentDate.toISOString().split("T")[0];

    query = `SELECT c.FirstName, c.LastName, c.AgeGroup, c.childID,? as AbsentDate
             FROM Child c
             LEFT JOIN studentAttendance sa 
             ON c.childID = sa.childID AND DATE(sa.SignInTime) = ?
             WHERE sa.SignInTime IS NULL`;

    queryParams.push(currentDate, currentDate);
  }

  if (childID) {
    query += (queryParams.length > 0 ? " AND" : " WHERE") + " c.childID = ?";
    queryParams.push(childID);
  }

  if (ageGroup) {
    query += (queryParams.length > 0 ? " AND" : " WHERE") + " c.AgeGroup = ?";
    queryParams.push(ageGroup);
  }

  connection.query(query, queryParams, (err, results) => {
    if (err) {
      res
        .status(500)
        .json({ success: false, message: "Error retrieving attendance data" });
    } else {
      res.json({ success: true, data: results });
    }
  });
});

app.get("/get_ledger_report", (req, res) => {
  let query = `SELECT 
   DATE_FORMAT(DATE_ADD(GeneratedDate, INTERVAL -WEEKDAY(GeneratedDate) DAY), '%Y-%m-%d') AS WeekStart, 
    DATE_FORMAT(DATE_ADD(GeneratedDate, INTERVAL 4 - WEEKDAY(GeneratedDate) DAY), '%Y-%m-%d') AS WeekEnd, 
    SUM(balance) AS TotalBilled,
    COALESCE(SUM(totalPaid), 0) AS TotalEarned
FROM 
    led
GROUP BY 
    WeekStart, WeekEnd;
`;
  connection.query(query, (err, result) => {
    res.json(result);
  });
});

app.post("/invite_parent", (req, res) => {
  let id = req.body.id;
  connection.query(
    "update parent set invite=true where ParentID=?",
    [id],
    (req, result) => {
      res.json({
        success: true,
        message: "Parent invited",
      });
    }
  );
});

app.post("/invite_staff", (req, res) => {
  let id = req.body.id;
  connection.query(
    "update staff set invite=true where ID=?",
    [id],
    (req, result) => {
      res.json({
        success: true,
        message: "Staff invited",
      });
    }
  );
});

app.post("/make_payment", (req, res) => {
  let id = req.body.id;
  let cardNumber = req.body.cardNumber;
  let cvv = req.body.cvv;
  let expiry = req.body.expiry;
  let name = req.body.name;
  let amount = req.body.amount;
  const parts = req.body.generatedDate.split("-");
  const generatedDate = `${parts[2]}-${parts[0]}-${parts[1]}`;

  const query =
    "INSERT INTO transactions (cardNumber, cvv, expiry, name,Amount,childId) VALUES (?, ?, ?, ?,?,?)";
  connection.query(
    query,
    [cardNumber, cvv, expiry, name, amount, id],
    (error, results) => {
      if (error) {
        console.error("Error executing INSERT query:", error);
        return;
      }

      const updateLedQuery = `
    UPDATE led
    SET balance = balance - ?,
        totalPaid = totalPaid + ?
    WHERE ChildID = ? AND DATE(GeneratedDate) = ?
  `;

      const updateLedValues = [amount, amount, id, generatedDate];

      connection.query(
        updateLedQuery,
        updateLedValues,
        (updateError, updateResults) => {
          if (updateError) {
            console.error("Error executing UPDATE query:", updateError);
            return;
          }
          res.json({
            success: true,
            message: "paid",
          });
        }
      );
    }
  );
});

app.get("/get_facility_information", (req, res) => {
  const userId = req.query.id; // Get the user ID from query parameter

  if (!userId) {
    res.status(400).json({ error: "User ID is required" });
    return;
  }

  const query = `
    SELECT 
      u.id, u.userName, u.firstName, u.lastName, u.email, u.phoneNumber, u.role,
      f.id AS facilityId, f.name, f.Address, f.phoneNumber AS facilityPhone, f.licenseNumber
    FROM 
      user_data AS u
      JOIN FACILITY AS f ON u.id = f.userId
    WHERE 
      u.id = ?;
  `;

  connection.query(query, [userId], (error, results) => {
    if (error) {
      console.error("Error executing query: " + error.stack);
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }

    if (results.length === 0) {
      res.status(404).json({ error: "No data found for the provided user ID" });
      return;
    }

    res.json(results[0]);
  });
});

app.post("/update_child_information", (req, res) => {
  let payload = req.body;
  const updateChildQuery =
    "UPDATE Child SET FirstName = ?, LastName = ?, Allergies = ? WHERE childID = ?";
  connection.query(
    updateChildQuery,
    [
      payload.ChildFirstName,
      payload.ChildLastName,
      payload.Allergies,
      payload.ChildID,
    ],
    (error, results) => {
      // Update parent table
      const updateParentQuery =
        "UPDATE parent SET  ParentFirstName = ?, ParentLastName = ?, PhoneNumber = ?, Address = ?  WHERE ParentID = ?";
      connection.query(
        updateParentQuery,
        [
          payload.ParentFirstName,
          payload.ParentLastName,
          payload.PhoneNumber,
          payload.Address,
          payload.ParentID,
        ],
        (error, results) => {
          res.json({
            message: "updated successfully",
          });
        }
      );
    }
  );
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
