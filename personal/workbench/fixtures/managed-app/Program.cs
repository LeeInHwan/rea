// MIT-licensed project-owned reference application. The recovery adapter receives
// only the compiled DLL; this source is used to build the original test artifact.
using System;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Windows.Forms;

namespace PersonalCalc
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length != 2 || args[0] != "--data-dir") return;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Calculator(args[1]));
        }
    }

    internal sealed class Calculator : Form
    {
        private readonly TextBox left = new TextBox();
        private readonly TextBox right = new TextBox();
        private readonly TextBox result = new TextBox();
        private readonly TextBox memo = new TextBox();
        private readonly TextBox status = new TextBox();
        private readonly string dataDirectory;

        public Calculator(string dataDirectory)
        {
            this.dataDirectory = dataDirectory;
            Text = "Personal REA Calculator";
            ClientSize = new Size(420, 300);
            AddText(left, "left", 20, 20);
            AddText(right, "right", 220, 20);
            AddText(result, "result", 20, 95);
            result.ReadOnly = true;
            AddText(memo, "memo", 20, 145);
            AddText(status, "status", 20, 240);
            status.ReadOnly = true;
            AddButton("calculate", "Add", 20, 55, Calculate);
            AddButton("clear", "Clear", 220, 55, Clear);
            AddButton("save", "Save", 20, 190, Save);
            AddButton("load", "Load", 220, 190, LoadMemo);
        }

        private void AddText(TextBox box, string name, int x, int y)
        {
            box.Name = name;
            box.AccessibleName = name;
            box.Location = new Point(x, y);
            box.Size = new Size(175, 25);
            Controls.Add(box);
        }

        private void AddButton(string name, string text, int x, int y, EventHandler action)
        {
            Button button = new Button();
            button.Name = name;
            button.AccessibleName = name;
            button.Text = text;
            button.Location = new Point(x, y);
            button.Size = new Size(175, 30);
            button.Click += action;
            Controls.Add(button);
        }

        private void Calculate(object sender, EventArgs args)
        {
            decimal first, second;
            if (!decimal.TryParse(left.Text, NumberStyles.Number, CultureInfo.InvariantCulture, out first)
                || !decimal.TryParse(right.Text, NumberStyles.Number, CultureInfo.InvariantCulture, out second))
                result.Text = "Invalid input";
            else
            {
                try { result.Text = (first + second).ToString(CultureInfo.InvariantCulture); }
                catch (OverflowException) { result.Text = "Overflow"; }
            }
        }

        private void Clear(object sender, EventArgs args)
        {
            left.Clear(); right.Clear(); result.Clear();
        }

        private void Save(object sender, EventArgs args)
        {
            Directory.CreateDirectory(dataDirectory);
            File.WriteAllText(Path.Combine(dataDirectory, "memo.txt"), memo.Text);
            status.Text = "Saved";
        }

        private void LoadMemo(object sender, EventArgs args)
        {
            string path = Path.Combine(dataDirectory, "memo.txt");
            memo.Text = File.Exists(path) ? File.ReadAllText(path) : "";
            status.Text = File.Exists(path) ? "Loaded" : "Missing";
        }
    }
}
